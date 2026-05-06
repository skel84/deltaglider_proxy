import { Alert, Button, Card, Space, Typography } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface RecoveryPanelProps {
  onExportBackup: () => void;
  onImportBackup: () => void;
}

export default function RecoveryPanel({ onExportBackup, onImportBackup }: RecoveryPanelProps) {
  return (
    <Card style={{ margin: 16, borderRadius: 12 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Text type="secondary">
          Download a full backup bundle (config + IAM/control-plane data), or restore from a previous export.
        </Text>
        <Space wrap>
          <Button type="primary" icon={<DownloadOutlined />} onClick={onExportBackup}>
            Download backup
          </Button>
          <Button icon={<UploadOutlined />} onClick={onImportBackup}>
            Restore backup
          </Button>
        </Space>
        <Alert
          type="warning"
          showIcon
          message="Restores can replace IAM users/groups/providers and configuration state for this instance."
        />
      </Space>
    </Card>
  );
}
