import { Typography } from 'antd';

const { Text } = Typography;

/**
 * Uppercase form-field label used across the IAM forms (UserForm, GroupForm).
 * Previously each form re-declared an identical local `label` helper.
 */
export default function FormLabel({ text, hint }: { text: string; hint?: string }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{text}</Text>
      {hint && <Text type="secondary" style={{ fontSize: 10, fontWeight: 400, marginLeft: 6 }}>{hint}</Text>}
    </div>
  );
}
