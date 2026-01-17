import React, { useState } from 'react';
import { useGraphSettings } from '../context/GraphSettingsContext';
import './GraphSettingsPanel.css';

const Accordion = ({ title, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="gsp-section">
      <div className="gsp-section-title" onClick={() => setIsOpen(!isOpen)}>
        {title}
        <span>{isOpen ? '−' : '+'}</span>
      </div>
      {isOpen && <div className="gsp-section-body">{children}</div>}
    </div>
  );
};

export const GraphSettingsPanel = ({ onClose }) => {
  const {
    scope, setScope,
    filters, setFilters,
    layout, setLayout,
    display, setDisplay,
    groups, setGroups
  } = useGraphSettings();

  const updateNested = (setter, key, val) => {
    setter(prev => ({ ...prev, [key]: val }));
  };

  const updateDeep = (setter, parent, key, val) => {
    setter(prev => ({
      ...prev,
      [parent]: { ...prev[parent], [key]: val }
    }));
  };

  return (
    <div className="graph-settings-panel">
      <div className="gsp-header">
        Graph Controls
        <button className="gsp-toggle-btn" onClick={onClose}>×</button>
      </div>
      
      <div className="gsp-content">
        {/* SCOPE */}
        <Accordion title="Scope & View" defaultOpen={true}>
          <div className="gsp-row">
            <span className="gsp-label">Mode</span>
            <div className="gsp-btn-group">
              <button 
                className={`gsp-btn ${scope.mode === 'global' ? 'active' : ''}`}
                onClick={() => updateNested(setScope, 'mode', 'global')}
              >Global</button>
              <button 
                className={`gsp-btn ${scope.mode === 'local' ? 'active' : ''}`}
                onClick={() => updateNested(setScope, 'mode', 'local')}
              >Local</button>
            </div>
          </div>
          
          {scope.mode === 'local' && (
            <div className="gsp-row">
              <span className="gsp-label">Depth ({scope.localDepth})</span>
              <input 
                type="range" min="1" max="5" 
                value={scope.localDepth} 
                onChange={(e) => updateNested(setScope, 'localDepth', parseInt(e.target.value))}
                className="gsp-slider"
              />
            </div>
          )}

          <label className="gsp-row">
            <span className="gsp-label">Hide Orphans</span>
            <input 
              type="checkbox" 
              checked={!scope.includeOrphans} 
              onChange={(e) => updateNested(setScope, 'includeOrphans', !e.target.checked)}
              className="gsp-checkbox"
            />
          </label>
        </Accordion>

        {/* FILTERS */}
        <Accordion title="Filters">
          <div className="gsp-grid">
            {Object.keys(filters.nodeTypes).map(type => (
              <label key={type} className="gsp-chip">
                <input 
                  type="checkbox" 
                  checked={filters.nodeTypes[type]} 
                  onChange={(e) => updateDeep(setFilters, 'nodeTypes', type, e.target.checked)}
                  className="gsp-checkbox"
                />
                <span style={{textTransform:'capitalize'}}>{type}</span>
              </label>
            ))}
          </div>
          <div className="gsp-row" style={{marginTop: 10}}>
            <span className="gsp-label">Min Risk ({filters.minRiskScore})</span>
            <input 
              type="range" min="0" max="10" 
              value={filters.minRiskScore} 
              onChange={(e) => updateNested(setFilters, 'minRiskScore', parseInt(e.target.value))}
              className="gsp-slider"
            />
          </div>
        </Accordion>

        {/* PHYSICS */}
        <Accordion title="Forces & Layout">
          <div className="gsp-row">
            <span className="gsp-label">Simulation</span>
            <button 
              className={`gsp-btn ${layout.isFrozen ? 'active' : ''}`}
              onClick={() => updateNested(setLayout, 'isFrozen', !layout.isFrozen)}
              style={{width: 'auto', flex: 'none'}}
            >
              {layout.isFrozen ? 'Frozen' : 'Running'}
            </button>
          </div>
          
          <div className="gsp-row">
            <span className="gsp-label">Repulsion</span>
            <input 
              type="range" min="50" max="1000" 
              value={layout.forces.repulsion} 
              onChange={(e) => updateDeep(setLayout, 'forces', 'repulsion', parseInt(e.target.value))}
              className="gsp-slider"
            />
          </div>

          <div className="gsp-row">
            <span className="gsp-label">Link Dist</span>
            <input 
              type="range" min="10" max="300" 
              value={layout.forces.linkDistance} 
              onChange={(e) => updateDeep(setLayout, 'forces', 'linkDistance', parseInt(e.target.value))}
              className="gsp-slider"
            />
          </div>

          <div className="gsp-row">
            <span className="gsp-label">Gravity</span>
            <input 
              type="range" min="0" max="100" 
              value={(layout.forces.center || 0.05) * 1000} 
              onChange={(e) => updateDeep(setLayout, 'forces', 'center', parseInt(e.target.value) / 1000)}
              className="gsp-slider"
            />
          </div>

          <label className="gsp-row">
            <span className="gsp-label">Lock Layout</span>
            <input 
              type="checkbox" 
              checked={layout.isLocked} 
              onChange={(e) => updateNested(setLayout, 'isLocked', e.target.checked)}
              className="gsp-checkbox"
            />
          </label>

          <div className="gsp-row" style={{ marginTop: 8 }}>
            <button 
              className="gsp-btn"
              onClick={() => {
                setLayout(prev => ({
                  ...prev,
                  forces: { repulsion: 300, center: 0.05, linkDistance: 70, friction: 0.6 },
                  isFrozen: false,
                  isLocked: false
                }));
              }}
            >
              Reset Forces
            </button>
          </div>
        </Accordion>

        {/* DISPLAY */}
        <Accordion title="Display">
          <div className="gsp-row">
            <span className="gsp-label">Node Size</span>
            <select 
              value={display.nodeSize} 
              onChange={(e) => updateNested(setDisplay, 'nodeSize', e.target.value)}
              className="gsp-select"
            >
              <option value="fixed">Fixed</option>
              <option value="degree">Connections</option>
              <option value="risk">Risk Score</option>
            </select>
          </div>
          <label className="gsp-row">
            <span className="gsp-label">Show Arrows</span>
            <input 
              type="checkbox" 
              checked={display.showArrows} 
              onChange={(e) => updateNested(setDisplay, 'showArrows', e.target.checked)}
              className="gsp-checkbox"
            />
          </label>
        </Accordion>

        {/* GROUPS */}
        <Accordion title="Groups & Colors">
          {groups.map(group => (
            <div key={group.id} className="gsp-row" style={{marginBottom: 6}}>
              <label className="gsp-chip" style={{flex: 1}}>
                <input 
                  type="checkbox" 
                  checked={group.active}
                  onChange={(e) => {
                    setGroups(prev => prev.map(g => g.id === group.id ? { ...g, active: e.target.checked } : g));
                  }}
                  className="gsp-checkbox"
                />
                <span style={{color: group.color, fontWeight: 700}}>●</span>
                <span>{group.label}</span>
              </label>
              <div className="gsp-meta" style={{fontSize: 10, color: '#566'}}>
                {group.query}
              </div>
            </div>
          ))}
          <div className="gsp-row" style={{marginTop: 8, justifyContent: 'center'}}>
            <span className="gsp-label" style={{fontSize: 10, fontStyle: 'italic'}}>
              (Groups override default colors)
            </span>
          </div>
        </Accordion>
      </div>
    </div>
  );
};
