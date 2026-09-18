// Off-site links open in a new tab; same-origin links navigate in place.
document.querySelectorAll('a[href]').forEach((a) => {
  if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
  a.target = '_blank';
  a.rel = 'noopener';
});
