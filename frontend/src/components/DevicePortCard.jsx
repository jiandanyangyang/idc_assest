import React, { memo, useState } from 'react';
import {
  Button,
  Card,
  Divider,
  Empty,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  BarcodeOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  ColumnHeightOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  DeleteOutlined,
  DownOutlined,
  EnvironmentOutlined,
  ExclamationCircleOutlined,
  GlobalOutlined,
  GatewayOutlined,
  HddOutlined,
  PartitionOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyOutlined,
  SwapOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { designTokens } from '../config/theme';
import { STATUS_MAP } from '../constants/deviceManagementConstants';

const { Text } = Typography;

/** 获取设备类型分类：server 为服务器，switch 涵盖所有网络设备（交换机/路由器/防火墙/存储等） */
const getDeviceType = device => {
  if (!device?.type) return 'unknown';
  const type = device.type.toLowerCase();
  if (type.includes('server')) return 'server';
  // 交换机、路由器、防火墙、存储等网络设备归为一类
  if (
    type.includes('switch') ||
    type.includes('router') ||
    type.includes('firewall') ||
    type.includes('storage') ||
    type.includes('loadbalancer')
  ) {
    return 'switch';
  }
  return 'other';
};

// 自定义类型（other）与网络设备一致，均无需关联网卡
const isSwitchDevice = device => {
  const t = getDeviceType(device);
  return t === 'switch' || t === 'other';
};

const isServerDevice = device => getDeviceType(device) === 'server';

/** 根据设备原始类型获取中文名标签 */
const getDeviceTypeLabel = device => {
  if (!device?.type) return '设备';
  const type = device.type.toLowerCase();
  if (type.includes('server')) return '服务器';
  if (type.includes('switch')) return '交换机';
  if (type.includes('router')) return '路由器';
  if (type.includes('firewall')) return '防火墙';
  if (type.includes('storage')) return '存储设备';
  if (type.includes('loadbalancer')) return '负载均衡';
  // 自定义类型直接展示原始值（如"无线控制器"）
  return device.type;
};

/** 获取设备图标 */
const getDeviceIcon = device => {
  if (!device?.type) return <AppstoreOutlined />;
  const type = device.type.toLowerCase();
  if (type.includes('server')) return <CloudServerOutlined />;
  if (type.includes('switch')) return <PartitionOutlined />;
  if (type.includes('router')) return <GatewayOutlined />;
  if (type.includes('firewall')) return <SafetyOutlined />;
  if (type.includes('storage')) return <HddOutlined />;
  if (type.includes('loadbalancer')) return <SwapOutlined />;
  // 自定义类型（无线控制器、上网行为管理等）统一用节点设备图标，与交换机区分
  return <DeploymentUnitOutlined />;
};

/**
 * 按设备原始类型返回图标背景渐变与阴影色
 * @param {Object} device - 设备对象
 * @returns {{ gradient: string, shadow: string }} 背景渐变与阴影色
 */
const getDeviceIconStyle = device => {
  if (!device?.type) return { gradient: 'linear-gradient(135deg, #64748b 0%, #475569 100%)', shadow: 'rgba(100, 116, 139, 0.3)' };
  const type = device.type.toLowerCase();
  if (type.includes('server')) return { gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', shadow: 'rgba(102, 126, 234, 0.3)' };
  if (type.includes('switch')) return { gradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', shadow: 'rgba(17, 153, 142, 0.3)' };
  if (type.includes('router')) return { gradient: 'linear-gradient(135deg, #f59e0b 0%, #f97316 100%)', shadow: 'rgba(245, 158, 11, 0.3)' };
  if (type.includes('firewall')) return { gradient: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)', shadow: 'rgba(239, 68, 68, 0.3)' };
  if (type.includes('storage')) return { gradient: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)', shadow: 'rgba(139, 92, 246, 0.3)' };
  if (type.includes('loadbalancer')) return { gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', shadow: 'rgba(59, 130, 246, 0.3)' };
  // 自定义类型用粉红渐变（色彩饱满，避免灰色辨识度不足）
  return { gradient: 'linear-gradient(135deg, #ec4899 0%, #db2777 100%)', shadow: 'rgba(236, 72, 153, 0.3)' };
};

/** 将设备状态值映射为带颜色的中文文本 */
const getDeviceStatusTag = status => {
  const config = STATUS_MAP[status];
  if (!config) return null;
  return (
    <Tag
      color={config.color}
      style={{ marginLeft: '4px', marginInlineEnd: 0, borderRadius: '4px', padding: '0 8px' }}
    >
      {config.text}
    </Tag>
  );
};

/**
 * 设备端口卡片组件（端口管理页设备卡片）
 *
 * 以 React.memo 包裹，勾选状态（selectedPortKeys）保留在卡片内部，
 * 避免跨设备勾选互相污染，且单个卡片内部状态变化不影响其他卡片渲染。
 *
 * @param {Object} props - 组件属性
 * @param {Object} props.device - 设备对象（含 deviceId/name/type/Rack 等字段）
 * @param {Array} props.ports - 该设备的端口数组（已按端口名排序）
 * @param {boolean} props.expanded - 是否展开端口列表（受控，展开状态由页面级维护）
 * @param {Function} props.onToggleExpand - 展开/收起回调，参数为设备ID
 * @param {Function} props.onCollect - 自动采集端口回调（非服务器设备显示），参数为设备对象
 * @param {Function} props.onAddPort - 添加端口回调，参数为设备对象
 * @param {Function} props.onManageNic - 网卡管理回调（服务器设备显示），参数为设备对象
 * @param {Function} props.onBatchDelete - 批量删除回调，参数为 (deviceId, portIds)，返回 Promise
 * @param {Array} props.portColumns - 端口表格列定义（父组件 useMemo 产出，服务器设备含网卡列）
 * @returns {JSX.Element} 设备端口卡片
 */
const DevicePortCard = ({
  device,
  ports,
  expanded,
  onToggleExpand,
  onCollect,
  onAddPort,
  onManageNic,
  onBatchDelete,
  portColumns,
}) => {
  // 本设备勾选的端口 key 列表（卡片内部状态，替代页面级共享 selectedRowKeys）
  const [selectedPortKeys, setSelectedPortKeys] = useState([]);

  const deviceId = device?.deviceId;
  const devicePorts = ports || [];
  const freeCount = devicePorts.filter(p => p.status === 'free').length;
  const occupiedCount = devicePorts.filter(p => p.status === 'occupied').length;
  const faultCount = devicePorts.filter(p => p.status === 'fault').length;

  /**
   * 批量删除当前设备勾选的端口
   * 确认并删除完成后清空本卡片勾选状态，避免残留指向已删除端口
   */
  const handleBatchDelete = () => {
    if (selectedPortKeys.length === 0) return;
    Promise.resolve(onBatchDelete(deviceId, selectedPortKeys)).finally(() => {
      setSelectedPortKeys([]);
    });
  };

  return (
    <Card
      style={{
        borderRadius: designTokens.borderRadius.lg,
        border: `1px solid ${designTokens.colors.neutral[200]}`,
        overflow: 'hidden',
      }}
      styles={{ body: { padding: 0 } }}
    >
      {/* 设备头部 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          background: expanded ? designTokens.colors.primary.light : '#fff',
          cursor: 'pointer',
          transition: 'background 0.2s',
        }}
        onClick={() => onToggleExpand(deviceId)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: designTokens.borderRadius.md,
              background: getDeviceIconStyle(device).gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '24px',
              boxShadow: `0 4px 12px ${getDeviceIconStyle(device).shadow}`,
            }}
          >
            {getDeviceIcon(device)}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: '16px',
                  color: designTokens.colors.neutral[800],
                }}
              >
                {device?.name || '未知设备'}
              </span>
              <Tag
                color={isServerDevice(device) ? 'blue' : isSwitchDevice(device) ? 'green' : 'default'}
                style={{ marginLeft: '4px' }}
              >
                {getDeviceTypeLabel(device)}
              </Tag>
            </div>
            <div
              style={{
                fontSize: '13px',
                color: designTokens.colors.neutral[500],
                marginTop: '2px',
              }}
            >
              {device?.deviceId || '-'} · {device?.model || device?.type || '设备'}
            </div>
            {/* 设备扩展信息：机房位置、机柜、U位、IP、SN、状态 */}
            <div
              style={{
                fontSize: '12px',
                color: designTokens.colors.neutral[500],
                marginTop: '6px',
                display: 'flex',
                gap: '12px',
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              {device?.Rack?.Room?.name && (
                <Tooltip title="机房">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <EnvironmentOutlined />
                    {device.Rack.Room.name}
                  </span>
                </Tooltip>
              )}
              {device?.Rack?.name && (
                <Tooltip title="机柜">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <DatabaseOutlined />
                    {device.Rack.name}
                  </span>
                </Tooltip>
              )}
              {device?.position != null && (
                <Tooltip title="U位">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <ColumnHeightOutlined />
                    U{device.position}
                    {device?.height ? `~${device.position + device.height - 1}` : ''}
                  </span>
                </Tooltip>
              )}
              {device?.ipAddress && (
                <Tooltip title="IP地址">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <GlobalOutlined />
                    {device.ipAddress}
                  </span>
                </Tooltip>
              )}
              {device?.serialNumber && (
                <Tooltip title="序列号">
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      maxWidth: '160px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <BarcodeOutlined />
                    {device.serialNumber}
                  </span>
                </Tooltip>
              )}
              {getDeviceStatusTag(device?.status)}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Space size="small">
            <Tooltip title="空闲">
              <Tag
                color="success"
                style={{ borderRadius: '4px', padding: '4px 12px' }}
                icon={<CheckCircleOutlined />}
              >
                {freeCount}
              </Tag>
            </Tooltip>
            <Tooltip title="占用">
              <Tag
                color="processing"
                style={{ borderRadius: '4px', padding: '4px 12px' }}
                icon={<AppstoreOutlined />}
              >
                {occupiedCount}
              </Tag>
            </Tooltip>
            {faultCount > 0 && (
              <Tooltip title="故障">
                <Tag
                  color="error"
                  style={{ borderRadius: '4px', padding: '4px 12px' }}
                  icon={<ExclamationCircleOutlined />}
                >
                  {faultCount}
                </Tag>
              </Tooltip>
            )}
            <Tag
              color="blue"
              style={{ borderRadius: '4px', padding: '4px 12px', fontWeight: 500 }}
            >
              总计: {devicePorts.length}
            </Tag>
          </Space>
          <Divider type="vertical" style={{ height: '24px', margin: '0 8px' }} />
          <Space size="small">
            {/* 自动采集端口（网络设备：交换机/路由器/存储/防火墙） */}
            {!isServerDevice(device) && (
              <Tooltip title="自动采集端口（SSH）">
                <Button
                  type="text"
                  icon={<ReloadOutlined />}
                  onClick={e => {
                    e.stopPropagation();
                    onCollect(device);
                  }}
                  style={{ color: designTokens.colors.primary.main }}
                />
              </Tooltip>
            )}
            <Tooltip
              title={
                isServerDevice(device) ? '添加端口' : '添加端口（交换机端口无需关联网卡）'
              }
            >
              <Button
                type="text"
                icon={<PlusOutlined />}
                onClick={e => {
                  e.stopPropagation();
                  onAddPort(device);
                }}
                style={{ color: designTokens.colors.primary.main }}
              />
            </Tooltip>
            {isServerDevice(device) && (
              <Tooltip title="网卡管理">
                <Button
                  type="text"
                  icon={<CloudServerOutlined />}
                  onClick={e => {
                    e.stopPropagation();
                    onManageNic(device);
                  }}
                  style={{ color: designTokens.colors.primary.main }}
                />
              </Tooltip>
            )}
            <Button
              type="text"
              size="small"
              icon={expanded ? <UpOutlined /> : <DownOutlined />}
              style={{ color: designTokens.colors.neutral[600], minWidth: '70px' }}
            >
              {expanded ? '收起' : '展开'}
            </Button>
          </Space>
        </div>
      </div>

      {/* 端口列表 */}
      {expanded && (
        <div
          style={{
            padding: '16px 20px',
            borderTop: `1px solid ${designTokens.colors.neutral[200]}`,
          }}
        >
          {devicePorts.length > 0 ? (
            <div>
              {selectedPortKeys.length > 0 && (
                <div
                  style={{
                    marginBottom: '12px',
                    padding: '8px 12px',
                    background: designTokens.colors.error.bg,
                    borderRadius: designTokens.borderRadius.sm,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text type="secondary">已选择 {selectedPortKeys.length} 个端口</Text>
                  <Button danger size="small" icon={<DeleteOutlined />} onClick={handleBatchDelete}>
                    批量删除
                  </Button>
                </div>
              )}
              <Table
                columns={
                  isServerDevice(device)
                    ? portColumns
                    : portColumns.filter(col => col.key !== 'networkCard')
                }
                dataSource={devicePorts}
                rowKey="portId"
                rowSelection={{
                  selectedRowKeys: selectedPortKeys,
                  onChange: setSelectedPortKeys,
                }}
                pagination={{
                  defaultPageSize: 10,
                  showSizeChanger: true,
                  showTotal: total => `共 ${total} 个端口`,
                  pageSizeOptions: ['10', '20', '50', '100'],
                }}
                size="middle"
                scroll={{ x: 1000 }}
              />
            </div>
          ) : (
            <Empty description="暂无端口数据" style={{ padding: '24px 0' }} />
          )}
        </div>
      )}
    </Card>
  );
};

export default memo(DevicePortCard);
