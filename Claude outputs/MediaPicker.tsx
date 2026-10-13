import CloseIcon from '@mui/icons-material/Close'
import SearchIcon from '@mui/icons-material/Search'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  MenuItem,
  Pagination,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Media } from '../../api/types'
import { tokens } from '../../theme'
import { MediaDetailsPanel } from './MediaDetailsPanel'
import { MediaThumb } from './MediaThumb'
import { MediaUploadZone } from './MediaUploadZone'
import { useMediaFolders, useMediaList } from './useMedia'

export interface MediaPickerProps {
  open: boolean
  onClose(): void
  onSelect(media: Media[]): void
  /** Default true. When false the dialog closes on the first pick. */
  multiple?: boolean
  maxSelection?: number
  /** Pre-tick items already attached to the thing being edited. */
  initialSelectedIds?: number[]
  title?: string
  confirmLabel?: string
}

const PAGE_SIZE = 24

/**
 * Shopify-style media picker.
 *
 * Two tabs, because the two jobs are genuinely different: "find the pack shot I
 * uploaded last week" and "put this new photo in". Uploading auto-selects the
 * result and drops you into the library so the flow ends in the same place
 * either way.
 */
export function MediaPicker({
  open,
  onClose,
  onSelect,
  multiple = true,
  maxSelection,
  initialSelectedIds = [],
  title = 'Select images',
  confirmLabel = 'Select',
}: MediaPickerProps) {
  const [tab, setTab] = useState<'library' | 'upload'>('library')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [folderId, setFolderId] = useState<number | ''>('')
  const [mediaType, setMediaType] = useState<string>('image')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Map<number, Media>>(new Map())
  const [focused, setFocused] = useState<Media | null>(null)

  const folders = useMediaFolders()

  // Debounce so typing "serum" is one request, not five.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const params = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      q: search || undefined,
      folder_id: folderId === '' ? undefined : folderId,
      media_type: mediaType || undefined,
      sort: 'created_at:desc',
    }),
    [page, search, folderId, mediaType],
  )

  const list = useMediaList(params, open)

  // Reset per-open rather than per-mount: the dialog stays mounted between
  // openings, and carrying last time's selection into a different product is
  // the kind of bug nobody reports but everybody hits.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTab('library')
      setSearchInput('')
      setSearch('')
      setPage(1)
      setFocused(null)
      setSelected(new Map())
    }
    wasOpen.current = open
  }, [open])

  // Pre-tick already-attached items once their rows arrive.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!open) {
      seededRef.current = false
      return
    }
    if (seededRef.current || initialSelectedIds.length === 0) return
    const rows = list.data?.media ?? []
    if (rows.length === 0) return
    const next = new Map<number, Media>()
    for (const item of rows) {
      if (initialSelectedIds.includes(item.id)) next.set(item.id, item)
    }
    if (next.size > 0) {
      setSelected(next)
      seededRef.current = true
    }
  }, [open, list.data, initialSelectedIds])

  const atLimit = maxSelection !== undefined && selected.size >= maxSelection

  const toggle = useCallback(
    (media: Media) => {
      setFocused(media)
      setSelected((current) => {
        const next = new Map(current)
        if (next.has(media.id)) {
          next.delete(media.id)
          return next
        }
        if (!multiple) return new Map([[media.id, media]])
        if (maxSelection !== undefined && next.size >= maxSelection) return next
        next.set(media.id, media)
        return next
      })
    },
    [multiple, maxSelection],
  )

  const confirm = () => {
    onSelect(Array.from(selected.values()))
    onClose()
  }

  const handleUploaded = useCallback(
    (uploaded: Media[]) => {
      setSelected((current) => {
        const next = multiple ? new Map(current) : new Map<number, Media>()
        for (const item of uploaded) {
          if (maxSelection !== undefined && next.size >= maxSelection) break
          next.set(item.id, item)
        }
        return next
      })
      setFocused(uploaded[0] ?? null)
      void list.refetch()
      setTab('library')
    },
    [multiple, maxSelection, list],
  )

  const rows = list.data?.media ?? []
  const pagination = list.data?.pagination

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      slotProps={{ paper: { sx: { height: '80dvh', maxHeight: 820 } } }}
    >
      <DialogTitle sx={{ pb: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" component="span">
            {title}
          </Typography>
          <IconButton onClick={onClose} size="small" aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <Tabs value={tab} onChange={(_, value: 'library' | 'upload') => setTab(value)} sx={{ mt: 1 }}>
          <Tab value="library" label="Library" />
          <Tab value="upload" label="Upload" />
        </Tabs>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ p: 0, display: 'flex', overflow: 'hidden' }}>
        {tab === 'upload' ? (
          <Box sx={{ p: 3, width: '100%', overflowY: 'auto' }}>
            <MediaUploadZone
              folderId={folderId === '' ? undefined : folderId}
              onUploaded={handleUploaded}
            />
          </Box>
        ) : (
          <>
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Stack direction="row" spacing={1.5} sx={{ p: 2, pb: 1.5, flexWrap: 'wrap' }}>
                <TextField
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search filename or alt text"
                  sx={{ flex: 1, minWidth: 200 }}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" />
                        </InputAdornment>
                      ),
                    },
                  }}
                />
                <TextField
                  select
                  label="Folder"
                  value={folderId}
                  onChange={(event) => {
                    setFolderId(event.target.value === '' ? '' : Number(event.target.value))
                    setPage(1)
                  }}
                  sx={{ minWidth: 150 }}
                >
                  <MenuItem value="">All folders</MenuItem>
                  {(folders.data?.folders ?? []).map((folder) => (
                    <MenuItem key={folder.id} value={folder.id}>
                      {'— '.repeat(folder.depth)}
                      {folder.name}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  label="Type"
                  value={mediaType}
                  onChange={(event) => {
                    setMediaType(event.target.value)
                    setPage(1)
                  }}
                  sx={{ minWidth: 130 }}
                >
                  <MenuItem value="">All types</MenuItem>
                  <MenuItem value="image">Images</MenuItem>
                  <MenuItem value="video">Video</MenuItem>
                  <MenuItem value="document">Documents</MenuItem>
                </TextField>
              </Stack>

              <Box sx={{ flex: 1, overflowY: 'auto', px: 2, pb: 2 }}>
                {list.isLoading ? (
                  <Box sx={{ display: 'grid', placeItems: 'center', height: 240 }}>
                    <CircularProgress size={24} />
                  </Box>
                ) : list.isError ? (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    Could not load the media library.
                  </Alert>
                ) : rows.length === 0 ? (
                  <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
                    <Typography variant="body2" sx={{ mb: 2 }}>
                      {search ? `Nothing matches “${search}”.` : 'No files here yet.'}
                    </Typography>
                    <Button variant="outlined" size="small" onClick={() => setTab('upload')}>
                      Upload files
                    </Button>
                  </Box>
                ) : (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
                      gap: 1.25,
                    }}
                  >
                    {rows.map((media) => (
                      <MediaThumb
                        key={media.id}
                        media={media}
                        selected={selected.has(media.id)}
                        focused={focused?.id === media.id}
                        selectable={!atLimit || selected.has(media.id)}
                        onToggle={toggle}
                        onFocus={setFocused}
                      />
                    ))}
                  </Box>
                )}
              </Box>

              {pagination && pagination.pages > 1 && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5, borderTop: `1px solid ${tokens.border}` }}>
                  <Pagination
                    size="small"
                    count={pagination.pages}
                    page={pagination.page}
                    onChange={(_, value) => setPage(value)}
                  />
                </Box>
              )}
            </Box>

            <Box
              sx={{
                width: 300,
                flexShrink: 0,
                borderLeft: `1px solid ${tokens.border}`,
                overflowY: 'auto',
                display: { xs: 'none', md: 'block' },
              }}
            >
              <MediaDetailsPanel media={focused} />
            </Box>
          </>
        )}
      </DialogContent>

      <Divider />

      <DialogActions sx={{ px: 2, py: 1.5, justifyContent: 'space-between' }}>
        <Typography variant="body2" color="text.secondary">
          {selected.size === 0
            ? 'Nothing selected'
            : `${selected.size} selected`}
          {atLimit && ` · maximum of ${maxSelection} reached`}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} color="inherit">
            Cancel
          </Button>
          <Button variant="contained" onClick={confirm} disabled={selected.size === 0}>
            {confirmLabel}
            {selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  )
}
