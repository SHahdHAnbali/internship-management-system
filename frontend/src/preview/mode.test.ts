import { previewActive } from './mode';

describe('Admin Preview Mode flag', () => {
  it('is off outside the admin-preview dev server', () => {
    expect(import.meta.env.MODE).not.toBe('admin-preview');
    expect(previewActive).toBe(false);
  });
});
