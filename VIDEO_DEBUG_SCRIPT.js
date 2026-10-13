/**
 * Video Banner Diagnostic Script
 * 
 * Paste this into your browser console on http://localhost:5174
 * This will identify why the video isn't playing
 */

(function videoBannerDiagnostic() {
  console.log('🔍 Starting Video Banner Diagnostic...\n');
  
  const results = {
    issues: [],
    info: []
  };

  // Check 1: Viewport Width
  const isPhone = window.matchMedia('(max-width: 640px)').matches;
  if (isPhone) {
    results.issues.push('❌ VIEWPORT: Screen width ≤ 640px detected (phone mode - videos disabled)');
  } else {
    results.info.push('✓ VIEWPORT: Desktop width detected');
  }
  
  // Check 2: Prefers Reduced Motion
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    results.issues.push('❌ MOTION: System prefers reduced motion (videos disabled)');
  } else {
    results.info.push('✓ MOTION: No motion reduction preference');
  }
  
  // Check 3: Video Element
  const videoElement = document.querySelector('[data-banner-video]');
  const imageElement = document.querySelector('[data-banner-id] img');
  
  if (!videoElement && imageElement) {
    results.issues.push('❌ DOM: <video> element not rendered, showing <img> instead');
    results.issues.push('   └─ This means playsFilm = false in BannerCarousel.tsx');
  } else if (!videoElement && !imageElement) {
    results.issues.push('❌ DOM: No video or image element found - banner may not be loaded');
  } else if (videoElement) {
    results.info.push('✓ DOM: <video> element exists');
    
    // Check video attributes
    console.log('\n📹 Video Element Details:');
    console.log({
      src: videoElement.src || videoElement.getAttribute('src'),
      poster: videoElement.poster,
      muted: videoElement.muted,
      autoplay: videoElement.autoplay,
      playsInline: videoElement.playsInline,
      loop: videoElement.loop,
      paused: videoElement.paused,
      ended: videoElement.ended,
      readyState: videoElement.readyState,
      networkState: videoElement.networkState,
      currentTime: videoElement.currentTime,
      duration: videoElement.duration || 'unknown',
      error: videoElement.error
    });
    
    // Check readyState
    const readyStates = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
    const readyStateText = readyStates[videoElement.readyState] || 'UNKNOWN';
    
    if (videoElement.readyState < 3) {
      results.issues.push(`⚠️ VIDEO STATE: ${readyStateText} - video may still be loading`);
    } else {
      results.info.push(`✓ VIDEO STATE: ${readyStateText}`);
    }
    
    // Check if video is paused
    if (videoElement.paused) {
      results.issues.push('❌ PLAYBACK: Video is paused (not playing)');
    } else {
      results.info.push('✓ PLAYBACK: Video is playing');
    }
    
    // Check for errors
    if (videoElement.error) {
      results.issues.push(`❌ VIDEO ERROR: ${videoElement.error.message} (code: ${videoElement.error.code})`);
    }
    
    // Check network state
    const networkStates = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];
    const networkStateText = networkStates[videoElement.networkState] || 'UNKNOWN';
    
    if (videoElement.networkState === 3) {
      results.issues.push(`❌ NETWORK: ${networkStateText} - video source not found`);
    } else {
      results.info.push(`✓ NETWORK: ${networkStateText}`);
    }
  }
  
  // Check 4: Banner Data
  const bannerElement = document.querySelector('[data-banner-id]');
  if (bannerElement) {
    const bannerId = bannerElement.getAttribute('data-banner-id');
    results.info.push(`✓ BANNER: Banner ID ${bannerId} found in DOM`);
  } else {
    results.issues.push('❌ BANNER: No banner element found');
  }
  
  // Check 5: Try to fetch banner data
  console.log('\n🌐 Fetching Banner Data...');
  fetch('/api/v1/content/banners?placement=home_hero,home_carousel')
    .then(r => r.json())
    .then(data => {
      console.log('Banner API Response:', data);
      
      const homeHeroBanners = data.banners?.home_hero || [];
      const homeCarouselBanners = data.banners?.home_carousel || [];
      const allBanners = [...homeHeroBanners, ...homeCarouselBanners];
      
      console.log(`\n📊 Found ${allBanners.length} banner(s)`);
      
      allBanners.forEach((banner, i) => {
        console.log(`\nBanner ${i + 1}:`, {
          id: banner.id,
          placement: banner.placement,
          media_type: banner.media_type,
          image: banner.image,
          poster: banner.poster,
          image_mobile: banner.image_mobile,
          mobile_is_video: banner.mobile_is_video
        });
        
        if (banner.media_type !== 'video') {
          console.warn(`  ⚠️ Banner is type "${banner.media_type}", not "video"`);
        }
        if (!banner.image) {
          console.warn(`  ⚠️ Banner has no image/video URL`);
        }
        if (!banner.poster) {
          console.warn(`  ℹ️ Banner has no poster (fallback for failed autoplay)`);
        }
      });
    })
    .catch(err => {
      console.error('❌ Failed to fetch banner data:', err);
    });
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📋 DIAGNOSTIC SUMMARY');
  console.log('='.repeat(60));
  
  if (results.issues.length > 0) {
    console.log('\n❌ ISSUES FOUND:');
    results.issues.forEach(issue => console.log(issue));
  }
  
  if (results.info.length > 0) {
    console.log('\n✓ CHECKS PASSED:');
    results.info.forEach(info => console.log(info));
  }
  
  // Diagnosis
  console.log('\n' + '='.repeat(60));
  console.log('💡 DIAGNOSIS:');
  console.log('='.repeat(60));
  
  if (isPhone) {
    console.log('\n🔴 PRIMARY ISSUE: Viewport width is ≤ 640px');
    console.log('   Videos are intentionally disabled on small screens.');
    console.log('   SOLUTION: Resize browser window to > 640px width or test on desktop.');
  } else if (prefersReducedMotion) {
    console.log('\n🔴 PRIMARY ISSUE: System motion preferences block video');
    console.log('   Your OS/browser is set to "prefers-reduced-motion: reduce"');
    console.log('   SOLUTION: Disable reduced motion in system settings or browser.');
  } else if (!videoElement) {
    console.log('\n🔴 PRIMARY ISSUE: Video element not rendered in DOM');
    console.log('   The condition playsFilm = false in BannerCarousel component.');
    console.log('   SOLUTION: Check browser console for React errors or data issues.');
  } else if (videoElement && videoElement.paused) {
    console.log('\n🔴 PRIMARY ISSUE: Video element exists but is not playing');
    console.log('   Attempting manual play...');
    
    videoElement.play()
      .then(() => {
        console.log('   ✅ Manual play succeeded! Video can play.');
        console.log('   ISSUE: Autoplay was blocked by browser initially.');
        console.log('   SOLUTION: This usually happens on first load. Refresh page or check autoplay policies.');
      })
      .catch(err => {
        console.error('   ❌ Manual play failed:', err.message);
        console.log('   SOLUTION: Check video file format, codec support, or file accessibility.');
      });
  } else if (videoElement && !videoElement.paused) {
    console.log('\n🟢 Video is playing successfully!');
    console.log('   If you don\'t see the video, check CSS visibility/z-index.');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('For detailed debugging steps, see: VIDEO_DEBUG_CHECKLIST.md');
  console.log('='.repeat(60) + '\n');
  
})();
