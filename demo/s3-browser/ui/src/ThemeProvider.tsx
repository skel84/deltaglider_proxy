import { useEffect, useState, type ReactNode } from 'react';
import { darkColors, lightColors, ThemeContext } from './ThemeContext';

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('dg-theme');
    return saved ? saved === 'dark' : true;
  });

  const toggleTheme = () => setIsDark(prev => !prev);
  const colors = isDark ? darkColors : lightColors;

  useEffect(() => {
    localStorage.setItem('dg-theme', isDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}
