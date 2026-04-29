import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItemButton,
  ListItemText,
  Button,
  TextField,
  IconButton,
  Box,
  Typography,
  CircularProgress,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { listDir, type DirListing } from '../api';

type Props = {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function FolderPicker({ open, initialPath, onClose, onSelect }: Props) {
  const [pathInput, setPathInput] = useState(initialPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(target?: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await listDir(target);
      setListing(result);
      setPathInput(result.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load(initialPath);
  }, [open, initialPath]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Select active folder</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <IconButton
            onClick={() => listing?.parent && load(listing.parent)}
            disabled={!listing?.parent}
          >
            <ArrowUpwardIcon />
          </IconButton>
          <TextField
            fullWidth
            size="small"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') load(pathInput);
            }}
          />
          <Button onClick={() => load(pathInput)}>Go</Button>
        </Box>
        {loading && <CircularProgress size={20} />}
        {error && (
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        )}
        {listing && (
          <List dense sx={{ maxHeight: 360, overflow: 'auto' }}>
            {listing.entries.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No subfolders
              </Typography>
            )}
            {listing.entries.map((e) => (
              <ListItemButton key={e.path} onClick={() => load(e.path)}>
                <FolderIcon fontSize="small" sx={{ mr: 1 }} />
                <ListItemText primary={e.name} />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          Select this folder
        </Button>
      </DialogActions>
    </Dialog>
  );
}
