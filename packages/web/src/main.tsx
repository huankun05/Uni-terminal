import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import './styles.css';
import { Landing } from './routes/Landing.tsx';
import { Pair } from './routes/Pair.tsx';
import { InAppBrowser } from './routes/InAppBrowser.tsx';
import { InstallGuide } from './routes/InstallGuide.tsx';
import { LocalLayout, LocalDashboard } from './routes/local/Dashboard.tsx';
import { LocalSettings } from './routes/local/Settings.tsx';
import { MLayout, MNow } from './routes/m/Now.tsx';
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
          <Route path="settings" element={<LocalSettings />} />
        </Route>

        <Route path="/m" element={<MLayout />}>
          <Route index element={<MNow />} />
          <Route path="s/:id" element={<MSession />} />
          <Route path="settings" element={<MSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
