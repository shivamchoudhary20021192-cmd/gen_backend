# React Hooks Error Fix

## Error Message
```
React has detected a change in the order of Hooks called by BannerCarousel. 
This will lead to bugs and errors if not fixed.

Uncaught Error: Should have a queue. You are likely calling Hooks conditionally, 
which is not allowed.
```

## Root Cause

The error occurred because `useIsPhone()` hook was being called **inline** in a variable declaration instead of at the **top level** of the component:

### ❌ WRONG (What was causing the error):
```typescript
export function BannerCarousel() {
  const { data } = useBanners(placements)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const seen = useRef(new Set<number>())
  
  // ... other code ...
  
  // ❌ Hook called inline in variable declaration
  const currentIsFilm = current?.media_type === 'video' && 
                        Boolean(current.image) && 
                        !useIsPhone()  // ← WRONG!
}
```

## The Fix

### ✅ CORRECT (Fixed version):
```typescript
export function BannerCarousel() {
  const { data } = useBanners(placements)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const seen = useRef(new Set<number>())
  
  // ✅ Hook called at top level, stored in variable
  const isPhone = useIsPhone()
  
  // ... other code ...
  
  // ✅ Use the variable, not the hook call
  const currentIsFilm = current?.media_type === 'video' && 
                        Boolean(current.image) && 
                        !isPhone  // ← CORRECT!
}
```

## Why This Matters

React's Rules of Hooks require that:
1. **Hooks must be called at the top level** - not inside loops, conditions, or nested functions
2. **Hooks must be called in the same order every render** - React relies on hook call order to maintain state

When `useIsPhone()` was called inline:
- It wasn't guaranteed to be called at the same position every render
- The hook order could change based on conditions
- React lost track of which state belonged to which hook

## Changes Applied

**File**: `D:\veylor_webapp\src\components\BannerCarousel.tsx`

**Change**: 
- Added `const isPhone = useIsPhone()` at component top level (line ~239)
- Changed `!useIsPhone()` to `!isPhone` in the `currentIsFilm` calculation (line ~267)

## Verification

After this fix:
- ✅ No more React Hooks errors in console
- ✅ Video playback logic still works correctly  
- ✅ Hook call order is consistent across renders
- ✅ Component renders without errors

## React Rules of Hooks

Remember these rules to avoid similar issues:

1. **Only call hooks at the top level**
   ```typescript
   // ✅ Good
   function Component() {
     const value = useCustomHook()
     // ... use value
   }
   
   // ❌ Bad
   function Component() {
     if (condition) {
       const value = useCustomHook()  // Wrong!
     }
   }
   ```

2. **Only call hooks from React functions**
   - ✅ React function components
   - ✅ Custom hooks (functions starting with `use`)
   - ❌ Regular JavaScript functions
   - ❌ Class components

3. **Call hooks in the same order every render**
   - Don't wrap hooks in conditions
   - Don't call hooks after early returns
   - Don't call hooks in loops

## Status

✅ **FIXED** - The React Hooks error has been resolved and videos should now work correctly.
