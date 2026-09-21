/**
 * 端口自动采集弹窗
 * 入口：端口管理页 → 设备操作列「自动采集」按钮
 * 流程：选择凭据 → 执行采集 → 差异预览（新增/变更/失效三态）→ 勾选确认 → 落库
 */
import { useState, useEffect, useMemo } from 'react';
import { Modal, Button, Steps, message, Spin, Alert, Tabs, Checkbox, Tag, Space, Card, Collapse } from 'antd';
import { CloudServerOutlined, ReloadOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { portDiscoveryAPI, deviceCredentialAPI } from '../api';

const VENDOR_LABELS = {
  huawei: '华为',
  cisco: '思科',
  h3c: '华三',
  ruijie: '锐捷',
  generic: '通用',
};

const DIFF_STEPS = [
  { title: '配置凭据', status: 'process' },
  { title: '执行采集', status: 'wait' },
  { title: '差异预览', status: 'wait' },
  { title: '确认落库', status: 'wait' },
];

/**
 * 端口差异预览弹窗（内部子组件）
 */
function DiffPreviewPanel({ diff, vendor, applying, onApply, onClose }) {
  // 注意：hooks 必须无条件调用，不能放在条件 return 之后
  const [applyAdded, setApplyAdded] = useState(true);
  const [applyChanged, setApplyChanged] = useState(true);
  const [applyRemoved, setApplyRemoved] = useState(false);

  // 注意：useMemo 必须在条件 return 之前调用（hooks 规则），
  // diff 为 null 时内部均为可选链/三元短路，构建 tabs 安全
  const tabs = useMemo(() => [
    {
      key: 'added',
      label: <Space><Tag color="green">+{diff.added?.length || 0}</Tag>新增端口</Space>,
      children: (diff.added?.length || 0) === 0
        ? <Alert type="info" message="没有新增端口" showIcon />
        : (
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>端口名</th>
                <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>类型</th>
                <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>速率</th>
                <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>状态</th>
                <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>VLAN</th>
                <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>描述</th>
              </tr></thead>
              <tbody>
                {diff.added.map((p, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{p.portName}</td>
                    <td style={{ padding: '6px 8px' }}>{p.portType}</td>
                    <td style={{ padding: '6px 8px' }}>{p.portSpeed || '-'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <Tag color={p.status === 'occupied' ? 'blue' : 'default'}>
                        {p.status === 'occupied' ? '占用' : p.status === 'fault' ? '故障' : '空闲'}
                      </Tag>
                    </td>
                    <td style={{ padding: '6px 8px' }}>{p.vlanId || '-'}</td>
                    <td style={{ padding: '6px 8px' }}>{p.description || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
    },
    {
      key: 'changed',
      label: <Space><Tag color="orange">~{diff.changed?.length || 0}</Tag>变更端口</Space>,
      children: (diff.changed?.length || 0) === 0
        ? <Alert type="info" message="没有变更端口" showIcon />
        : (
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {diff.changed.map((p, i) => (
              <Card key={i} size="small" style={{ marginBottom: 8, fontSize: 13 }}>
                <div style={{ marginBottom: 4, fontFamily: 'monospace', fontWeight: 500 }}>{p.portName}</div>
                {p.fieldChanges && Object.entries(p.fieldChanges).map(([field, change]) => (
                  <div key={field} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', minWidth: 60 }}>{field}</span>
                    <span style={{ textDecoration: 'line-through', color: '#ff4d4f' }}>{change.from ?? 'null'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <span style={{ color: '#52c41a' }}>{change.to ?? 'null'}</span>
                  </div>
                ))}
              </Card>
            ))}
          </div>
        ),
    },
    {
      key: 'removed',
      label: <Space><Tag color="red">-{diff.removed?.length || 0}</Tag>失效端口</Space>,
      children: (diff.removed?.length || 0) === 0
        ? <Alert type="info" message="没有失效端口（设备上端口列表完整）" showIcon />
        : (
          <div>
            <Alert
              type="warning"
              showIcon
              message={`检测到 ${diff.removed.length} 个端口在设备上已不存在，勾选下方"移除"以同步删除库中记录`}
              style={{ marginBottom: 8 }}
            />
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {diff.removed.map((p, i) => (
                <div key={i} style={{ padding: '4px 0', fontFamily: 'monospace' }}>{p.portName}</div>
              ))}
            </div>
          </div>
        ),
    },
  ], [diff]);

  if (!diff) return null;

  return (
    <div>
      <Alert
        type="success"
        showIcon
        icon={<CheckCircleOutlined />}
        message="采集完成"
        description={
          <Space>
            <span>厂商：{VENDOR_LABELS[vendor || 'generic'] || vendor || '未知'}</span>
            <span>新增 {diff.added?.length || 0} / 变更 {diff.changed?.length || 0} / 失效 {diff.removed?.length || 0}</span>
          </Space>
        }
        style={{ marginBottom: 12 }}
      />
      <Tabs items={tabs} style={{ marginBottom: 12 }} />
      <Space wrap size={16} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
        <Checkbox checked={applyAdded} onChange={e => setApplyAdded(e.target.checked)}>
          应用新增（{diff.added?.length || 0}）
        </Checkbox>
        <Checkbox checked={applyChanged} onChange={e => setApplyChanged(e.target.checked)}>
          应用变更（{diff.changed?.length || 0}）
        </Checkbox>
        <Checkbox checked={applyRemoved} onChange={e => setApplyRemoved(e.target.checked)} disabled={!diff.removed?.length}>
          同步移除失效（{diff.removed?.length || 0}）
        </Checkbox>
      </Space>
      <div style={{ textAlign: 'right', marginTop: 16 }}>
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={applying}
            disabled={!applyAdded && !applyChanged && !applyRemoved}
            onClick={() => onApply({ applyAdded, applyChanged, applyRemoved })}
          >
            确认落库
          </Button>
        </Space>
      </div>
    </div>
  );
}

/**
 * 端口自动采集弹窗（主组件）
 */
export default function PortDiscoveryModal({ open, onClose, deviceId, deviceName, defaultCredentialId }) {
  const [step, setStep] = useState(0);
  const [credentials, setCredentials] = useState([]);
  const [selectedCredId, setSelectedCredId] = useState(defaultCredentialId || null);
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null); // { vendor, ports, diff }
  const [error, setError] = useState(null);
  const [errorRaw, setErrorRaw] = useState(null); // 采集失败时设备返回的原始输出（诊断用）
  const [applyStats, setApplyStats] = useState(null);

  // 加载设备已有凭据
  useEffect(() => {
    if (!open || !deviceId) return;
    setError(null);
    setErrorRaw(null);
    setResult(null);
    setApplyStats(null);
    setStep(0);
    deviceCredentialAPI.list({ deviceId }).then(res => {
      const list = res.data || res.credentials || [];
      setCredentials(list);
      // 自动选择默认凭据
      const def = list.find(c => c.isDefault);
      setSelectedCredId(def?.credentialId || list[0]?.credentialId || null);
    }).catch(() => setCredentials([]));
  }, [open, deviceId]);

  /** 执行采集 */
  const handleDiscover = async () => {
    setError(null);
    setErrorRaw(null);
    setCollecting(true);
    setStep(1);
    try {
      const res = await portDiscoveryAPI.discover({
        deviceId,
        credentialId: selectedCredId || undefined,
      });
      if (!res.success) throw new Error(res.message || '采集失败');
      // 后端返回为平铺结构：{ success, vendor, diff, ... }（不含 data 字段）
      setResult({ diff: res.diff, vendor: res.vendor });
      setStep(2);
    } catch (err) {
      setError(err.message);
      // 采集失败时后端会附带设备原始输出，展示出来便于定位解析问题
      setErrorRaw(err.response?.data?.rawOutput || null);
      setStep(0);
    } finally {
      setCollecting(false);
    }
  };

  /** 执行落库 */
  const handleApply = async (options) => {
    setApplying(true);
    setStep(3);
    try {
      const res = await portDiscoveryAPI.apply({
        deviceId,
        diff: result.diff,
        options,
      });
      if (!res.success) throw new Error(res.message || '落库失败');
      setApplyStats(res.data || res.stats);
      message.success('端口数据落库完成');
      setTimeout(() => onClose(true), 1500);
    } catch (err) {
      setError(err.message);
      setStep(2);
    } finally {
      setApplying(false);
    }
  };

  const renderConfigStep = () => (
    <div style={{ minHeight: 240 }}>
      {credentials.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="该设备尚未配置 SSH 凭据"
          description="请先到「设备详情 → 网络凭据」页面添加凭据，或直接在下方手动指定"
          style={{ marginBottom: 16 }}
        />
      ) : (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 500, marginBottom: 8 }}>选择 SSH 凭据：</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {credentials.map(c => (
              <div
                key={c.credentialId}
                onClick={() => setSelectedCredId(c.credentialId)}
                style={{
                  padding: '10px 14px',
                  border: `1px solid ${selectedCredId === c.credentialId ? 'var(--brand, #4B3FE3)' : 'var(--border)'}`,
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: selectedCredId === c.credentialId ? 'var(--brand-soft, #F2F7FF)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>
                    {c.username || '(无用户名)'}@{c.host}:{c.port || 22}
                  </span>
                  <Space size={4}>
                    {c.isDefault && <Tag color="blue">默认</Tag>}
                    {c.vendor && <Tag>{VENDOR_LABELS[c.vendor] || c.vendor}</Tag>}
                    {c.testStatus === 'success' && <Tag color="green">已连通</Tag>}
                    {c.testStatus === 'failed' && <Tag color="red">失败</Tag>}
                  </Space>
                </div>
                {c.testMessage && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{c.testMessage}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <Alert
        type="info"
        showIcon
        message="提示"
        description="采集命令仅包含只读白名单（display interface brief / display port vlan），不会对设备产生任何修改。"
        style={{ marginTop: 16 }}
      />
    </div>
  );

  const renderCollecting = () => (
    <div style={{ textAlign: 'center', padding: '40px 0' }}>
      <Spin indicator={<CloudServerOutlined style={{ fontSize: 48 }} spin />} />
      <div style={{ marginTop: 16, color: 'var(--text-muted)' }}>正在连接设备并抓取端口列表...</div>
      <div style={{ marginTop: 8, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
        deviceId={deviceId} credentialId={selectedCredId || '(自动)'}
      </div>
    </div>
  );

  const renderCollectFailed = () => (
    <div style={{ padding: 24 }}>
      <Alert type="error" showIcon message="采集失败" description={error} style={{ marginBottom: 16 }} />
      {errorRaw && (
        <Collapse
          size="small"
          style={{ marginBottom: 16 }}
          items={[
            {
              key: 'raw',
              label: `查看设备原始输出（${errorRaw.length} 字符，可复制反馈排查）`,
              children: (
                <pre
                  style={{
                    maxHeight: 320,
                    overflow: 'auto',
                    fontSize: 12,
                    lineHeight: 1.6,
                    background: 'rgba(0,0,0,0.03)',
                    padding: 12,
                    borderRadius: 6,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {errorRaw}
                </pre>
              ),
            },
          ]}
        />
      )}
      <div style={{ textAlign: 'right' }}>
        <Button onClick={() => { setError(null); setErrorRaw(null); }}>重试</Button>
      </div>
    </div>
  );

  const renderApplyResult = () => (
    <div style={{ padding: '32px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
      <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 12 }}>落库完成</div>
      {applyStats && (
        <Space size={24}>
          <div><span style={{ color: '#52c41a', fontWeight: 500 }}>+{applyStats.added}</span> 新增</div>
          <div><span style={{ color: '#fa8c16', fontWeight: 500 }}>~{applyStats.changed}</span> 变更</div>
          <div><span style={{ color: '#ff4d4f', fontWeight: 500 }}>-{applyStats.removed}</span> 移除</div>
          {applyStats.failed > 0 && <div><span style={{ color: '#ff4d4f', fontWeight: 500 }}>{applyStats.failed}</span> 失败</div>}
        </Space>
      )}
    </div>
  );

  return (
    <Modal
      title={
        <Space>
          <CloudServerOutlined />
          自动采集端口 {deviceName ? `— ${deviceName}` : ''}
        </Space>
      }
      open={open}
      onCancel={() => onClose()}
      width={820}
      maskClosable={false}
      destroyOnClose
      footer={
        // 第一步（含采集中）：显示「开始采集」；失败态只留「关闭」；
        // 差异预览和落库完成态由内容区自带按钮，footer 置空
        step === 0 && !error ? (
          <Space>
            <Button onClick={() => onClose()}>取消</Button>
            <Button
              type="primary"
              loading={collecting}
              disabled={collecting || credentials.length === 0 || !selectedCredId}
              onClick={handleDiscover}
            >
              {collecting ? '采集中...' : '开始采集'}
            </Button>
          </Space>
        ) : step === 0 && error ? (
          <Button onClick={() => onClose()}>关闭</Button>
        ) : null
      }
    >
      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 20 }}
        items={DIFF_STEPS}
      />

      {step === 0 && !error && renderConfigStep()}
      {step === 0 && error && renderCollectFailed()}
      {step === 1 && renderCollecting()}
      {step === 2 && result && (
        <>
          {/* 落库失败时在预览面板上方展示错误，允许重试确认落库 */}
          {error && (
            <Alert
              type="error"
              showIcon
              closable
              message="落库失败"
              description={error}
              onClose={() => setError(null)}
              style={{ marginBottom: 12 }}
            />
          )}
          <DiffPreviewPanel
            diff={result.diff}
            vendor={result.vendor}
            applying={applying}
            onApply={handleApply}
            onClose={() => { setResult(null); setStep(0); }}
          />
        </>
      )}
      {step === 3 && renderApplyResult()}
    </Modal>
  );
}
