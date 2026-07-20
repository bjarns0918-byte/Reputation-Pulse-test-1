function showToast(message, type) {
  type = type || 'success';
  let layer = document.getElementById('toastLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'toastLayer';
    layer.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:9999; display:flex; flex-direction:column; gap:8px; align-items:center; pointer-events:none;';
    document.body.appendChild(layer);
  }
  const bg = type === 'error' ? '#D64545' : '#14213D';
  const icon = type === 'error'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16h.01" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="#fff" stroke-width="1.6"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const toast = document.createElement('div');
  toast.style.cssText = 'display:flex; align-items:center; gap:8px; background:' + bg + '; color:#fff; padding:10px 16px; border-radius:8px; font-size:13px; font-family:"IBM Plex Sans",-apple-system,sans-serif; opacity:0; transform:translateY(-8px); transition:opacity 0.25s ease, transform 0.25s ease; box-shadow:0 4px 14px rgba(0,0,0,0.18);';
  toast.innerHTML = icon + '<span>' + message + '</span>';
  layer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    setTimeout(() => toast.remove(), 300);
  }, 2400);
}
