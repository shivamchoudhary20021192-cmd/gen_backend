# Frontend Footer Update - Hide Avatar in Collapsed Mode

## File to Update
`D:\veylog-fronend-admin\src\components\AppLayout.tsx`

## Changes Required

### Find the Footer Section (around line 600-650)

Look for this code:
```tsx
{/* Footer - Fixed at bottom with User Profile and Toggle */}
<Box
  sx={{
    borderTop: `1px solid ${alpha('#000', 0.08)}`,
    p: 1.5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 1,
    flexShrink: 0,
    bgcolor: '#fff',
  }}
>
```

### Replace the ENTIRE Footer Section with:

```tsx
{/* Footer - Fixed at bottom with User Profile and Toggle */}
<Box
  sx={{
    borderTop: `1px solid ${alpha('#000', 0.08)}`,
    p: isCollapsed ? 1 : 1.5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: isCollapsed ? 'center' : 'space-between',
    gap: 1,
    flexShrink: 0,
    bgcolor: '#fff',
  }}
>
  {/* User Profile - Hidden in collapsed mode */}
  {!isCollapsed && (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
      <Avatar
        sx={{
          width: 32,
          height: 32,
          bgcolor: tokens.subdued,
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        SA
      </Avatar>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          admin@veylor.com
        </Typography>
        <Typography variant="caption" sx={{ color: tokens.subdued }} noWrap>
          Super admin
        </Typography>
      </Box>
    </Box>
  )}

  {/* Toggle Button */}
  <Tooltip title={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'} placement="right">
    <IconButton
      onClick={() => sidebar.toggle()}
      size="small"
      sx={{
        color: isCollapsed ? tokens.primary : tokens.subdued,
        bgcolor: isCollapsed ? alpha(tokens.primary, 0.08) : 'transparent',
        border: isCollapsed ? `1px solid ${alpha(tokens.primary, 0.2)}` : 'none',
        '&:hover': {
          bgcolor: isCollapsed ? alpha(tokens.primary, 0.12) : alpha('#000', 0.05),
        },
      }}
    >
      {isCollapsed ? <MenuOpenIcon fontSize="small" /> : <MenuIcon fontSize="small" />}
    </IconButton>
  </Tooltip>
</Box>
```

## What Changed

1. **Padding adjusted for collapsed mode:**
   ```tsx
   p: isCollapsed ? 1 : 1.5,
   ```

2. **Justify content changes based on state:**
   ```tsx
   justifyContent: isCollapsed ? 'center' : 'space-between',
   ```

3. **User profile wrapped in conditional:**
   ```tsx
   {!isCollapsed && (
     // Avatar, email, and role only show when expanded
   )}
   ```

## Result

**Collapsed Mode (64px):**
- ❌ No SA avatar
- ❌ No email/role text  
- ✅ Only blue toggle button (centered)

**Expanded Mode (232px):**
- ✅ SA avatar visible
- ✅ admin@veylor.com visible
- ✅ Super admin role visible
- ✅ Gray toggle button on right

## Testing

1. Save the file
2. The dev server should auto-reload
3. Click the toggle button - avatar should hide/show
4. Press Ctrl+B - same behavior
5. In collapsed mode, only the blue icon button should be visible

---
**Status:** Ready to apply
**File:** `D:\veylog-fronend-admin\src\components\AppLayout.tsx`
**Section:** Footer (around line 600-650)
