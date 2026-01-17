// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Mock react-force-graph-2d because it is an ESM module which Jest cannot parse by default
jest.mock('react-force-graph-2d', () => {
  return function ForceGraph2D() {
    return <div data-testid="force-graph-2d" />;
  };
});

// Mock d3-force because it is an ESM module which Jest cannot parse by default
jest.mock('d3-force', () => {
  const force = () => {
    const chain = () => chain;
    chain.strength = () => chain;
    chain.radius = () => chain;
    chain.id = () => chain;
    chain.distance = () => chain;
    return chain;
  };
  return {
    forceManyBody: force,
    forceCollide: force,
    forceLink: force,
    forceCenter: force,
    forceRadial: force,
    forceX: force,
    forceY: force
  };
});

// Mock axios because it is an ESM module which Jest cannot parse by default
jest.mock('axios', () => ({
  get: jest.fn(() => Promise.resolve({ data: {} })),
  post: jest.fn(() => Promise.resolve({ data: {} })),
  put: jest.fn(() => Promise.resolve({ data: {} })),
  delete: jest.fn(() => Promise.resolve({ data: {} })),
  create: jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() }
    }
  }))
}));

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
