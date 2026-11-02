import { screen } from '@testing-library/react';
import { HomePage } from './HomePage';
import { renderPage, testI18n } from '../../test/render';

describe('HomePage', () => {
  it('introduces the internship program with the company logo', async () => {
    renderPage(<HomePage />, {
      i18n: testI18n(
        {
          home: {
            titleStart: 'The ProGineer ',
            titleAccent: 'Internship',
            titleEnd: ' Program',
            logoAlt: 'ProGineer Technologies',
          },
        },
        'en',
      ),
    });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'The ProGineer Internship Program',
    );
    expect(screen.getAllByRole('img', { name: 'ProGineer Technologies' })[0]).toHaveAttribute(
      'src',
      '/brand/progineer-logo.png',
    );
  });

  it('links Sign in to the sign-in page and keeps Apply disabled until the application form exists', async () => {
    renderPage(<HomePage />);
    expect(await screen.findByRole('link', { name: 'home.signIn' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.getByRole('button', { name: 'home.apply' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/',
      '/sign-in',
    ]);
  });
});
