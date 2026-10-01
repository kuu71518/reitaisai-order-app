const PATHS = {
  menu: ['M4 3v6a3 3 0 0 0 6 0V3M7 3v18M19 3c-3 2-4 5-4 9h4M19 3v18'],
  history: ['M7 3h10v18l-2-1-3 1-3-1-2 1V3Z', 'M10 8h4M10 12h4M10 16h2'],
  manager: ['M9 4H5v17h14V4h-4M9 3h6v4H9z', 'm8 13 2 2 5-5'],
  summary: ['m7 3 5 8 5-8M6 11h12M6 15h12M12 11v10'],
  admin: ['M4 6h16M4 12h16M4 18h16', 'M8 3v6M16 9v6M10 15v6'],
};

export default function NavIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {(PATHS[name] || PATHS.menu).map((path, index) => <path key={index} d={path} />)}
    </svg>
  );
}
