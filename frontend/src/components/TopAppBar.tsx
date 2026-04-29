import { useState } from 'react';
import { AppBar, Toolbar, Typography, IconButton, Box } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { FolderPicker } from './FolderPicker';

type Props = {
  activeFolder: string;
  onSelectFolder: (path: string) => void;
};

export function TopAppBar({ activeFolder, onSelectFolder }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const folderName = activeFolder
    ? activeFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeFolder
    : '(no folder)';

  return (
    <>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar variant="dense">
          <Typography variant="h6" sx={{ mr: 2, fontWeight: 600 }}>
            Lattice
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
            <Typography variant="body1" sx={{ fontFamily: 'monospace' }}>
              {folderName}
            </Typography>
            <IconButton
              size="small"
              onClick={() => setPickerOpen(true)}
              title="Select folder"
            >
              <FolderOpenIcon fontSize="small" />
            </IconButton>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ ml: 1, fontFamily: 'monospace' }}
            >
              {activeFolder}
            </Typography>
          </Box>
        </Toolbar>
      </AppBar>
      <FolderPicker
        open={pickerOpen}
        initialPath={activeFolder}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          setPickerOpen(false);
          onSelectFolder(p);
        }}
      />
    </>
  );
}
