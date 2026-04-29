import { useEffect, useState } from 'react';
import { Box, CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { TopAppBar } from './components/TopAppBar';
import { Sidebar } from './components/Sidebar';
import { ForceGraphView } from './components/ForceGraphView';
import { fetchDefaultRoot, scanFolder, type ScanResult } from './api';

const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0b0c0f', paper: '#14161a' },
  },
  typography: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
});

function App() {
  const [activeFolder, setActiveFolder] = useState<string>('');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchDefaultRoot()
      .then((p) => setActiveFolder(p))
      .catch(() => setActiveFolder(''));
  }, []);

  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    setLoading(true);
    scanFolder(activeFolder)
      .then((r) => {
        if (!cancelled) setScanResult(r);
      })
      .catch((err) => {
        console.error('scan failed', err);
        if (!cancelled) setScanResult(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          height: '100vh',
          width: '100vw',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <TopAppBar
          activeFolder={activeFolder}
          onSelectFolder={setActiveFolder}
        />
        <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <Box sx={{ width: 360, minWidth: 280, height: '100%' }}>
            <Sidebar activeFolder={activeFolder} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
            <ForceGraphView data={scanResult} loading={loading} />
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

export default App;
