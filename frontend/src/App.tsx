import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { PreviewBanner } from './components/PreviewBanner';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App() {
  return (
    <>
      <PreviewBanner />
      <RouterProvider router={router} />
    </>
  );
}
