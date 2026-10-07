import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { Provider } from 'react-redux';
import store from './stores';
import { appRoutes } from './router';
import './styles/main.css';

/** 主题：铁路蓝灰 + 安全橙，工程台账观感 */
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1565c0' },
    secondary: { main: '#00897b' },
    warning: { main: '#ed6c02' },
    error: { main: '#d32f2f' },
    success: { main: '#2e7d32' },
    background: { default: '#f4f6f8', paper: '#ffffff' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily:
      '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif',
    button: { textTransform: 'none' },
  },
  components: {
    MuiCard: { defaultProps: { variant: 'outlined' } },
    MuiPaper: { defaultProps: { elevation: 0 } },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载节点');
}

// 使用 History（Browser）路由：真实路径 /yards、/workorders… 直接访问与刷新都由
// nginx.conf 的 `try_files $uri $uri/ /index.html;` 回落，深链才真正生效。
// （Hash 路由会把路径写成 /#/yards，导致 /yards 这类深链一律落到 /）
const router = createBrowserRouter(appRoutes);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <RouterProvider router={router} />
      </ThemeProvider>
    </Provider>
  </React.StrictMode>,
);
