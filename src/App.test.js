import { render, screen } from '@testing-library/react';
import App from './App';
import { GraphSettingsProvider } from './context/GraphSettingsContext';

test('renders WEB RECON MAP title', () => {
  render(
    <GraphSettingsProvider>
      <App />
    </GraphSettingsProvider>
  );
  const linkElement = screen.getByText(/WEB RECON MAP/i);
  expect(linkElement).toBeInTheDocument();
});