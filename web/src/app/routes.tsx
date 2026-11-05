import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';

const OverviewPage = lazy(() => import('../pages/Overview'));
const MachinesPage = lazy(() => import('../pages/Machines'));
const MachineDetailPage = lazy(() => import('../pages/MachineDetail'));
const MountDetailPage = lazy(() => import('../pages/MountDetail'));
const FilesPage = lazy(() => import('../pages/Files'));
const IssuesPage = lazy(() => import('../pages/Issues'));
const JobsPage = lazy(() => import('../pages/Jobs'));
const JobDetailPage = lazy(() => import('../pages/JobDetail'));
const RepairsPage = lazy(() => import('../pages/Repairs'));
const AuditPage = lazy(() => import('../pages/Audit'));
const SystemPage = lazy(() => import('../pages/System'));
const NotFoundPage = lazy(() => import('../pages/NotFound'));

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<OverviewPage />} />
      <Route path="/machines" element={<MachinesPage />} />
      <Route path="/machines/:id" element={<MachineDetailPage />} />
      <Route path="/mounts/:id" element={<MountDetailPage />} />
      <Route path="/files" element={<FilesPage />} />
      <Route path="/issues" element={<IssuesPage />} />
      <Route path="/jobs" element={<JobsPage />} />
      <Route path="/jobs/:id" element={<JobDetailPage />} />
      <Route path="/repairs" element={<RepairsPage />} />
      <Route path="/audit" element={<AuditPage />} />
      <Route path="/system" element={<SystemPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
