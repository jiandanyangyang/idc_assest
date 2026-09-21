import React from 'react';
import { Modal, Empty } from 'antd';
import {
  PictureOutlined,
  ThunderboltOutlined,
  CloseOutlined,
  CloudUploadOutlined,
} from '@ant-design/icons';
import ImageUploader from './ImageUploader';
import { designTokens } from '../../config/theme';

/** 弹窗交互态样式（hover 用 class 承载，避免内联样式压制 :hover） */
const modalStyles = `
.imm-close {
  position: absolute;
  top: 13px;
  right: 13px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: ${designTokens.colors.text.secondary};
  background: rgba(255, 255, 255, 0.72);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, transform 0.25s ease;
}
.imm-close:hover {
  background: #fff;
  color: ${designTokens.colors.error.main};
  transform: rotate(90deg);
}
.imm-chip {
  width: 36px;
  height: 36px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: #fff;
  background: ${designTokens.colors.primary.gradient};
  box-shadow: 0 6px 14px -5px rgba(99, 102, 241, 0.6);
  flex: 0 0 auto;
}
.imm-count {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 17px;
  color: ${designTokens.colors.primary.dark};
  background: #e0e7ff;
  border: 1px solid #c7d2fe;
}
.imm-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  margin-bottom: 14px;
  border-radius: 9px;
  font-size: 12px;
  color: ${designTokens.colors.primary.dark};
  background: linear-gradient(135deg, #f5f7ff 0%, #eef2ff 100%);
  border: 1px solid #dbe4ff;
}
`;

/**
 * 通用图片管理弹窗（设备 / 耗材等复用）
 *
 * 在列表「操作」列点击「图片」按钮后弹出，对该条记录直接做图片的查看 / 上传 / 删除。
 * 上传与删除即时落库（复用 ImageUploader 服务模式），父级通过 onChange 回写最新数组，
 * 因此弹窗本身不持有副本状态，始终以传入的 images 为准。
 *
 * @param {boolean}  open      是否可见
 * @param {string}   entity    'devices' | 'consumables'
 * @param {string}   entityId  实体主键；为空时不可管理
 * @param {Array}    images    当前图片数组 [{url,name,size,uploadedAt}]
 * @param {string}   title     弹窗标题
 * @param {Function} onClose   关闭回调
 * @param {Function} onChange  图片变更回调 (images) => void
 */
const ImageManagerModal = ({
  open,
  entity,
  entityId,
  images,
  title = '图片管理',
  onClose,
  onChange,
}) => {
  const list = Array.isArray(images) ? images : [];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      centered
      width={500}
      footer={null}
      closable={false}
      maskClosable
      className="imm-modal"
      styles={{
        content: {
          padding: 0,
          borderRadius: '18px',
          overflow: 'hidden',
          height: '500px',
          maxHeight: 'calc(100vh - 40px)',
          display: 'flex',
          flexDirection: 'column',
        },
        body: {
          padding: 0,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      <style>{modalStyles}</style>

      {/* 头部：渐变底 + 图标芯片 + 标题/数量 + 自定义关闭 */}
      <div
        style={{
          flexShrink: 0,
          position: 'relative',
          padding: '16px 18px 14px',
          background: 'linear-gradient(135deg, #f5f7ff 0%, #eef6ff 100%)',
          borderBottom: '1px solid #e6ecfb',
        }}
      >
        <button type="button" className="imm-close" onClick={onClose} aria-label="关闭">
          <CloseOutlined />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '11px', paddingRight: '34px' }}>
          <div className="imm-chip">
            <PictureOutlined />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span
                style={{
                  fontSize: '15px',
                  fontWeight: 600,
                  color: designTokens.colors.text.primary,
                }}
              >
                {title}
              </span>
              <span className="imm-count">{list.length} 张</span>
            </div>
            <div
              style={{
                marginTop: '2px',
                fontSize: '12px',
                color: designTokens.colors.text.tertiary,
              }}
            >
              管理该记录的图片，支持预览大图
            </div>
          </div>
        </div>
      </div>

      {/* 内容区：提示条贴顶，图片网格在剩余空间内垂直 + 水平居中，整体分布均匀 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: '16px 18px 18px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {entityId ? (
          <>
            <div className="imm-notice" style={{ flexShrink: 0, marginBottom: '14px' }}>
              <ThunderboltOutlined />
              <span>上传与删除即时保存，无需额外提交</span>
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflowY: 'auto',
              }}
            >
              <div style={{ width: '100%' }}>
                <ImageUploader
                  entity={entity}
                  entityId={entityId}
                  value={list}
                  onChange={onChange}
                  align="center"
                />
              </div>
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Empty
              image={<CloudUploadOutlined style={{ fontSize: '34px', color: '#c7d2fe' }} />}
              description="暂无可管理的图片"
            />
          </div>
        )}
      </div>
    </Modal>
  );
};

export default React.memo(ImageManagerModal);
