import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TrayView } from './TrayView';
import './styles.css';
import './app.css';

// The same page serves the tray panel, opened with #tray.
const tray = location.hash === '#tray';
if (tray) document.documentElement.classList.add('tray-page');
createRoot(document.getElementById('root')!).render(<React.StrictMode>{tray ? <TrayView /> : <App />}</React.StrictMode>);
