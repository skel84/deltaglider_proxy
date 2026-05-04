import { ConfigProvider } from 'antd';
import App from './App';
import { lightTheme, darkTheme } from './theme';
import { useTheme } from './ThemeContext';

export default function Root() {
  const { isDark } = useTheme();
  return (
    <ConfigProvider theme={isDark ? darkTheme : lightTheme}>
      <App />
    </ConfigProvider>
  );
}
