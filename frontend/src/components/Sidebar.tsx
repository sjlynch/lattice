import { useState } from 'react';
import {
  Box,
  Tabs,
  Tab,
  IconButton,
  Typography,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { TerminalPane } from './TerminalPane';

type TerminalTab = {
  id: string;
  label: string;
  cwd: string;
};

type Props = {
  activeFolder: string;
};

export function Sidebar({ activeFolder }: Props) {
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const [active, setActive] = useState(0);

  function addTerminal() {
    const id = String(Date.now());
    const label = `claude ${terminals.length + 1}`;
    setTerminals((t) => [...t, { id, label, cwd: activeFolder }]);
    setActive(terminals.length);
  }

  function closeTerminal(idx: number) {
    setTerminals((t) => t.filter((_, i) => i !== idx));
    setActive((a) => Math.max(0, Math.min(a, terminals.length - 2)));
  }

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1,
          py: 0.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography variant="overline" sx={{ pl: 1 }}>
          Terminals
        </Typography>
        <Tooltip title="New Claude terminal">
          <IconButton size="small" onClick={addTerminal}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {terminals.length > 0 && (
        <Tabs
          value={active}
          onChange={(_, v) => setActive(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ minHeight: 32 }}
        >
          {terminals.map((t, i) => (
            <Tab
              key={t.id}
              sx={{ minHeight: 32, py: 0.25, textTransform: 'none' }}
              label={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <span>{t.label}</span>
                  <CloseIcon
                    fontSize="inherit"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(i);
                    }}
                    sx={{ cursor: 'pointer', opacity: 0.6, '&:hover': { opacity: 1 } }}
                  />
                </Box>
              }
            />
          ))}
        </Tabs>
      )}

      <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {terminals.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'text.secondary',
              p: 2,
              textAlign: 'center',
            }}
          >
            <Typography variant="body2">
              Click + to start a Claude Code terminal in
              <br />
              <code>{activeFolder}</code>
            </Typography>
          </Box>
        ) : (
          terminals.map((t, i) => (
            <Box
              key={t.id}
              sx={{
                position: 'absolute',
                inset: 0,
                visibility: i === active ? 'visible' : 'hidden',
              }}
            >
              <TerminalPane cwd={t.cwd} active={i === active} />
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
