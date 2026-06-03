import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { darkColors, lightColors, ThemeContext } from './ThemeContext';

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('dg-theme');
    return saved ? saved === 'dark' : true;
  });

  // Stable identity so the context value (and therefore every `useColors()` /
  // `useTheme()` consumer — i.e. nearly the whole tree) only churns on an actual
  // theme change, not on every ThemeProvider render.
  const toggleTheme = useCallback(() => setIsDark((prev) => !prev), []);
  const colors = isDark ? darkColors : lightColors;

  useEffect(() => {
    localStorage.setItem('dg-theme', isDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const value = useMemo(() => ({ isDark, toggleTheme, colors }), [isDark, toggleTheme, colors]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
