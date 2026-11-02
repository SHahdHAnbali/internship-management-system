import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { adminCache } from '../features/admin/adminCache';

afterEach(() => {
  cleanup();
  adminCache.clear(); // each test starts without Admin data remembered from another test
});
