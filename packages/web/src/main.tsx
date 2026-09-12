import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import './styles.css';
import { Landing } from './routes/Landing.tsx';
import { Pair } from './routes/Pair.tsx';
import { InAppBrowser } from './routes/InAppBrowser.tsx';
import { InstallGuide } from './routes/InstallGuide.tsx';
import { LocalLayout, LocalDashboard } from './routes/local/Dashboard.tsx';
import { LocalPairing } from './routes/local/Pairing.tsx';
import { LocalDevices } from './routes/local/Devices.tsx';
import { LocalDiagnostics } from './routes/local/Diagnostics.tsx';
import { LocalSession } from './routes/local/LocalSession.tsx';
import { LocalSettings } from './routes/local/Settings.tsx';
import { MLayout, MNow } from './routes/m/Now.tsx';
import { MNewTask } from './routes/m/NewTask.tsx';
import { MSession } from './routes/m/Session.tsx';
import { MSettings } from './routes/m/Settings.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pair" element={<Pair />} />
        <Route path="/inapp" element={<InAppBrowser />} />
        <Route path="/install" element={<InstallGuide />} />

        <Route path="/local" element={<LocalLayout />}>
          <Route index element={<LocalDashboard />} />
          <Route path="pairing" element={<LocalPairing />} />
          <Route path="devices" element={<LocalDevices />} />
          <Route path="settings" element={<LocalSettings />} />
          <Route path="diagnostics" element={<LocalDiagnostics />} />
          <Route path="sessions/:id" element={<LocalSession />} />
        </Route>

        <Route path="/m" element={<MLayout />}>
          <Route index element={<MNow />} />
          <Route path="now" element={<MNow />} />
          <Route path="new" element={<MNewTask />} />
          <Route path="s/:id" element={<MSession />} />
          <Route path="settings" element={<MSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
