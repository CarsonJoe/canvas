import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { canvasMcpTools, CanvasMcpTools } from './services/canvasMcp';

declare global {
  interface Window {
    canvasMcp?: CanvasMcpTools;
  }
}

window.canvasMcp = canvasMcpTools;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
