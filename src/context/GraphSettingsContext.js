import React, { createContext, useContext, useState, useMemo } from 'react';

const GraphSettingsContext = createContext();

export const useGraphSettings = () => useContext(GraphSettingsContext);

export const GraphSettingsProvider = ({ children }) => {
  // Scope
  const [scope, setScope] = useState({
    mode: 'global', // 'global' | 'local'
    localDepth: 2,
    includeOrphans: false,
    includeTags: true
  });

  // Filters
  const [filters, setFilters] = useState({
    nodeTypes: {
      host: true,
      domain: true,
      subdomain: true,
      directory: true,
      file: true,
      ip: true,
      finding: true
    },
    minRiskScore: 0,
    httpStatuses: {
      '200': true,
      '300': true,
      '400': true,
      '500': true
    },
    searchQuery: ''
  });

  // Layout / Physics
  const [layout, setLayout] = useState({
    isFrozen: false,
    isLocked: false,
    engine: 'force', // 'force', 'dag', 'radial'
    forces: {
      repulsion: 300,
      center: 0.05,
      linkDistance: 70,
      friction: 0.6
    }
  });

  // Display / Styling
  const [display, setDisplay] = useState({
    nodeSize: 'fixed', // 'fixed', 'degree', 'risk'
    labelThreshold: 1.5,
    showArrows: true,
    darkMode: true
  });

  // Groups (Custom Coloring)
  const [groups, setGroups] = useState([
    { id: 'g1', type: 'query', query: 'status:403', color: '#F59E0B', label: '403 Forbidden', active: true },
    { id: 'g2', type: 'query', query: 'status:500', color: '#EF4444', label: '500 Error', active: true },
    { id: 'g3', type: 'query', query: 'risk:high', color: '#DC2626', label: 'High Risk', active: true }
  ]);

  const value = useMemo(() => ({
    scope, setScope,
    filters, setFilters,
    layout, setLayout,
    display, setDisplay,
    groups, setGroups
  }), [scope, filters, layout, display, groups]);

  return (
    <GraphSettingsContext.Provider value={value}>
      {children}
    </GraphSettingsContext.Provider>
  );
};
