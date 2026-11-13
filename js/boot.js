// Runs before first paint: restores the saved colours so the app never flashes the wrong theme.
(function () {
  try {
    var v = JSON.parse(localStorage.getItem('hark.themeVars') || 'null');
    if (!v) return;
    var st = document.documentElement.style;
    for (var k in v) st.setProperty(k, v[k]);
    st.colorScheme = v['--scheme'] || 'light';
    var m = document.querySelector('meta[name="theme-color"]');
    if (m && v['--bg']) m.setAttribute('content', v['--bg']);
  } catch (e) { /* first run */ }
})();
