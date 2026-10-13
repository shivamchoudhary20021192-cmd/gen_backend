# Video Banner Debug Checklist

## Issue
Videos play in admin portal but not in webapp banner (http://localhost:5174)

## API Comparison

### Admin API (✓ Working)
- Endpoint: `http://localhost:5173/admin/api/v1/content/banners/1`
- Returns: Full media object with URL

### Webapp API (Issue)
- Endpoint: `http://localhost:5174/api/v1/content/banners?placement=home_hero`
- Returns: Transformed banner with `image`, `media_type`, `poster` fields

## Debug Steps (Check These in Browser)

### 1. Check Browser Console
Open browser console (F12) on http://localhost:5174 and look for:
- ❌ Any errors related to video loading
- ❌ CORS errors
- ❌ 404 errors for video file
- ⚠️ Warnings about autoplay being blocked

### 2. Check Network Tab
In Network tab, filter by `.mp4`:
- ✓ Does the video file request happen?
- ✓ What's the response status? (200 OK, 404, 403?)
- ✓ Is the URL correct: `/media/media/2026/09/.../original.mp4`?

### 3. Check Video Element in DOM
Inspect the page and find the `<video>` element:
```html
<video src="/media/..." data-banner-video="1" ...>
```

Check:
- ✓ Does the `<video>` element exist? (Or is `<img>` shown instead?)
- ✓ Does it have the correct `src` attribute?
- ✓ Does it have `muted` attribute?
- ✓ Does it have `playsInline` attribute?

### 4. Check Viewport Width
In browser console, run:
```javascript
window.matchMedia('(max-width: 640px)').matches
```
- ❌ If `true`, video won't play (phone detection blocks it)
- ✓ If `false`, proceed to next check

### 5. Check Prefers Reduced Motion
In browser console, run:
```javascript
window.matchMedia('(prefers-reduced-motion: reduce)').matches
```
- ❌ If `true`, video won't play (OS setting blocks it)
- ✓ If `false`, proceed to next check

### 6. Check Video Element Attributes
In browser console, find video element:
```javascript
const video = document.querySelector('[data-banner-video]')
console.log({
  src: video?.src,
  muted: video?.muted,
  paused: video?.paused,
  readyState: video?.readyState,
  networkState: video?.networkState,
  error: video?.error
})
```

**ReadyState values:**
- 0 = HAVE_NOTHING (no data loaded)
- 1 = HAVE_METADATA (metadata loaded)
- 2 = HAVE_CURRENT_DATA
- 3 = HAVE_FUTURE_DATA
- 4 = HAVE_ENOUGH_DATA (should be playing)

**NetworkState values:**
- 0 = NETWORK_EMPTY
- 1 = NETWORK_IDLE
- 2 = NETWORK_LOADING
- 3 = NETWORK_NO_SOURCE

### 7. Manual Play Test
Try manually playing the video in console:
```javascript
const video = document.querySelector('[data-banner-video]')
video.play().then(() => {
  console.log('✓ Video playing successfully')
}).catch(err => {
  console.error('❌ Video play failed:', err.message)
})
```

### 8. Check If Image is Shown Instead
If you see a poster image instead of video:
```javascript
const img = document.querySelector('[data-banner-id] img')
const video = document.querySelector('[data-banner-id] video')
console.log({
  showingImage: !!img,
  showingVideo: !!video,
  imageSrc: img?.src,
  videoSrc: video?.src
})
```

## Expected Behavior Conditions

Video WILL play if:
- ✓ `banner.media_type === 'video'`
- ✓ `banner.image` is not null (video URL exists)
- ✓ Viewport width > 640px
- ✓ `prefers-reduced-motion` is NOT set
- ✓ Video file is accessible
- ✓ Browser allows autoplay (muted videos should work)

Video WON'T play if:
- ❌ Any of the above conditions fail
- ❌ `playsFilm` evaluates to `false`

## Common Issues

### Issue: Video element doesn't exist, showing image instead
**Cause:** `playsFilm` is false
**Check:** Viewport width and motion preferences

### Issue: Video element exists but doesn't play
**Cause:** Autoplay blocked or video file issue
**Check:** Browser console errors, network tab, file accessibility

### Issue: Video loads but shows black screen
**Cause:** Video codec not supported or corrupted file
**Check:** Try playing the video URL directly in browser

### Issue: Video plays in admin but not webapp
**Cause:** Different screen sizes or different video rendering logic
**Check:** Resize browser window, check responsive behavior

## Next Steps

After running these checks, report which step failed:
1. If viewport check fails → Need to test on desktop viewport width
2. If motion preference fails → Need to disable OS motion reduction
3. If video file fails to load → Check backend media serving
4. If video element doesn't exist → Frontend logic blocking it
5. If video exists but won't play → Browser autoplay policy issue

## Testing URLs

- Admin (working): http://localhost:5173/admin/content/banners/1
- Webapp (issue): http://localhost:5174
- Direct API: http://localhost:5174/api/v1/content/banners?placement=home_hero
- Direct video: http://localhost:5174/media/media/2026/09/31553e55-dd31-4e44-95d4-fa3e740f31b6/original.mp4
