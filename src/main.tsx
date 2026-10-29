import {installWasmConsoleFilter} from './utils/wasmConsoleFilter';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

installWasmConsoleFilter();

createRoot(document.getElementById('root')!).render(<App />);
