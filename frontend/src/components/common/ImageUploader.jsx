import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Image, Tooltip, Alert, message } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  LoadingOutlined,
  EyeOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { designTokens } from '../../config/theme';
import { imageAPI } from '../../api';

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp';
const ACCEPT_LIST = ACCEPT.split(',');
const MAX_SIZE_MB = 10;
const TILE = 92;

/** 瓦片与交互态样式（用独立 class 承载 hover，避免内联样式压制 :hover） */
const uploaderStyles = `
.idu-group { display: flex; flex-wrap: wrap; gap: 12px; }
.idu-tile, .idu-add {
  position: relative;
  width: ${TILE}px;
  height: ${TILE}px;
  flex: 0 0 auto;
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e8ecf6;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.22s ease,
    border-color 0.22s ease, background 0.22s ease;
}
.idu-tile:hover, .idu-add:hover {
  transform: translateY(-3px);
  box-shadow: 0 10px 20px -6px rgba(15, 23, 42, 0.18);
  border-color: #c7d2fe;
}
.idu-tile img { transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
.idu-tile:hover img { transform: scale(1.06); }

.idu-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  border: 1.5px dashed #c7d2fe;
  background: linear-gradient(135deg, #f8faff 0%, #eef2ff 100%);
  box-shadow: none;
}
.idu-add:hover {
  border-color: #6366f1;
  background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
  box-shadow: 0 10px 20px -6px rgba(99, 102, 241, 0.35);
}
.idu-add.is-disabled { cursor: not-allowed; opacity: 0.55; }
.idu-add.is-disabled:hover {
  transform: none;
  border-color: #c7d2fe;
  background: linear-gradient(135deg, #f8faff 0%, #eef2ff 100%);
  box-shadow: none;
}

.idu-del {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  cursor: pointer;
  background: rgba(15, 23, 42, 0.55);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  opacity: 0.85;
  transition: opacity 0.2s ease, background 0.2s ease, transform 0.2s ease;
}
.idu-tile:hover .idu-del { opacity: 1; }
.idu-del:hover { background: rgba(239, 68, 68, 0.92); transform: scale(1.08); }

.idu-badge {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  color: #fff;
  background: rgba(99, 102, 241, 0.92);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  border-top-right-radius: 10px;
}

.idu-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  color: ${designTokens.colors.text.tertiary};
}
.idu-preview-mask {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 12px;
}
`;

const addChipStyle = {
  width: '30px',
  height: '30px',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#fff',
  boxShadow: '0 2px 6px rgba(99, 102, 241, 0.22)',
};

/**
 * 通用图片上传组件（设备 / 耗材等复用）
 *
 * 两种模式：
 * - 服务模式（传入 entityId）：选择即上传、删除即调用接口，onChange 回写服务端最新数组
 * - 暂存模式（entityId 为空，如新增表单）：仅本地暂存 File，由父级保存成功后统一上传
 *
 * @param {string}   entity          实体分类，如 'devices' / 'consumables'
 * @param {string?}  entityId        实体主键；为空则进入暂存模式
 * @param {Array}    value           服务端图片数组 [{url,name,size,uploadedAt}]
 * @param {Function} onChange        服务模式回写 (images) => void
 * @param {Array}    pendingFiles    暂存模式的文件数组 File[]
 * @param {Function} onPendingChange 暂存模式回写 (files) => void
 * @param {string}   align           网格与提示的对齐方式：'flex-start'（默认，表单用）| 'center'（弹窗用，视觉更均匀）
 */
const ImageUploader = ({
  entity,
  entityId,
  value = [],
  onChange,
  pendingFiles = [],
  onPendingChange,
  disabled = false,
  maxCount = 10,
  tip,
  align = 'flex-start',
}) => {
  const isServerMode = Boolean(entityId);
  const [uploading, setUploading] = useState(false);
  // 上传请求串行链：多选或连点时保证后一次一定基于前一次的结果，避免并发覆盖与响应乱序
  const uploadChainRef = useRef(Promise.resolve());
  // 在途上传数：用于并发场景下正确判断是否已达上限（items.length 在异步期间是旧值）
  const inFlightRef = useRef(0);

  // 暂存模式：为 File 生成本地预览
  const stagedItems = useMemo(
    () =>
      (pendingFiles || []).map(file => ({
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        staged: true,
      })),
    [pendingFiles]
  );

  // 卸载 / 变更时释放 objectURL，避免内存泄漏
  useEffect(
    () => () => {
      stagedItems.forEach(item => URL.revokeObjectURL(item.url));
    },
    [stagedItems]
  );

  const items = isServerMode ? value || [] : stagedItems;
  const reachedMax = items.length >= maxCount;

  const doUpload = useCallback(
    async file => {
      if (isServerMode) {
        setUploading(true);
        try {
          const res = await imageAPI.upload(entity, entityId, file);
          onChange?.(res?.data?.images || []);
          // 固定 key：多张连传时合并为一条提示，避免提示刷屏
          message.success({ content: '图片上传成功', key: 'idu-upload' });
        } finally {
          setUploading(false);
        }
      } else {
        onPendingChange?.([...(pendingFiles || []), file]);
      }
    },
    [isServerMode, entity, entityId, onChange, onPendingChange, pendingFiles]
  );

  /**
   * 串行化上传
   *
   * 一次选择多张时 antd 会对每个文件各调用一次 beforeUpload。若直接并发请求，
   * 即使服务端已串行处理，响应到达顺序仍不确定，onChange 可能被较早的响应对应
   * 的旧数组覆盖，导致列表显示不全。这里用 Promise 链保证逐个上传。
   */
  const handleAdd = useCallback(
    file => {
      const next = uploadChainRef.current.then(
        () => doUpload(file),
        () => doUpload(file)
      );
      // 链尾吞掉异常，保证后续文件仍能继续上传
      uploadChainRef.current = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
    [doUpload]
  );

  const handleRemove = useCallback(
    async (index, item) => {
      if (isServerMode) {
        const res = await imageAPI.remove(entity, entityId, item.url);
        onChange?.(res?.data?.images || []);
        message.success({ content: '图片已删除', key: 'idu-delete' });
      } else {
        onPendingChange?.((pendingFiles || []).filter((_, i) => i !== index));
      }
    },
    [isServerMode, entity, entityId, onChange, onPendingChange, pendingFiles]
  );

  const beforeUpload = file => {
    // 并发选择多张时 items.length 还是旧值，需叠加在途上传数才能正确判断上限
    if (items.length + inFlightRef.current >= maxCount) {
      message.warning({ content: `最多上传 ${maxCount} 张图片`, key: 'idu-warn' });
      return Upload.LIST_IGNORE;
    }
    if (!ACCEPT_LIST.includes(file.type)) {
      message.error({ content: '只支持 JPG、PNG、GIF、WebP 格式的图片', key: 'idu-warn' });
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      message.error({ content: `图片不能超过 ${MAX_SIZE_MB}MB`, key: 'idu-warn' });
      return Upload.LIST_IGNORE;
    }

    inFlightRef.current += 1;
    handleAdd(file)
      .catch(error => {
        message.error({
          content: error?.friendlyMessage || error?.message || '图片上传失败',
          key: 'idu-upload',
        });
      })
      .finally(() => {
        inFlightRef.current -= 1;
      });

    // 阻止 antd 默认上传行为，统一由 handleAdd 处理
    return Upload.LIST_IGNORE;
  };

  return (
    <div>
      <style>{uploaderStyles}</style>

      <div className="idu-group" style={{ justifyContent: align }}>
        {items.length > 0 && (
          <Image.PreviewGroup>
            {items.map((item, index) => (
              <div key={`${item.url}-${index}`} className="idu-tile">
                <Image
                  src={item.url}
                  alt={item.name || '图片'}
                  width={TILE}
                  height={TILE}
                  style={{ objectFit: 'cover', width: `${TILE}px`, height: `${TILE}px` }}
                  preview={{
                    mask: (
                      <span className="idu-preview-mask">
                        <EyeOutlined style={{ fontSize: '16px' }} />
                        预览
                      </span>
                    ),
                  }}
                />
                {!disabled && (
                  <Tooltip title="删除">
                    <button
                      type="button"
                      className="idu-del"
                      onClick={e => {
                        e.stopPropagation();
                        handleRemove(index, item).catch(error => {
                          message.error({
                            content: error?.friendlyMessage || error?.message || '删除失败',
                            key: 'idu-delete',
                          });
                        });
                      }}
                    >
                      <DeleteOutlined />
                    </button>
                  </Tooltip>
                )}
                {item.staged && <span className="idu-badge">待保存</span>}
              </div>
            ))}
          </Image.PreviewGroup>
        )}

        {!disabled && (
          <Upload
            accept={ACCEPT}
            multiple
            showUploadList={false}
            beforeUpload={beforeUpload}
            disabled={reachedMax || uploading}
          >
            <div className={`idu-add${reachedMax ? ' is-disabled' : ''}`}>
              {uploading ? (
                <LoadingOutlined
                  style={{ fontSize: '17px', color: designTokens.colors.primary.main }}
                />
              ) : (
                <div style={addChipStyle}>
                  <PlusOutlined
                    style={{ fontSize: '15px', color: designTokens.colors.primary.main }}
                  />
                </div>
              )}
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: designTokens.colors.primary.main,
                }}
              >
                {uploading ? '上传中' : '上传图片'}
              </span>
            </div>
          </Upload>
        )}
      </div>

      <div className="idu-tip" style={{ justifyContent: align }}>
        <InfoCircleOutlined />
        <span>
          {tip || `支持 JPG/PNG/GIF/WebP，单张不超过 ${MAX_SIZE_MB}MB，最多 ${maxCount} 张`}
        </span>
      </div>

      {!isServerMode && items.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: '12px', borderRadius: '10px' }}
          message="图片将在保存后自动上传"
        />
      )}
    </div>
  );
};

export default React.memo(ImageUploader);
