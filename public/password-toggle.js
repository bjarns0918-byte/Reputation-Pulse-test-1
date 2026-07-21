(function () {
  const EYE_OPEN = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>';
  const EYE_CLOSED = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M2 12s4-7 10-7c1.6 0 3 .3 4.3.8M22 12s-4 7-10 7c-1.6 0-3-.3-4.3-.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 9.8a3 3 0 0 0 4.2 4.2M2 2l20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function addToggles() {
    document.querySelectorAll('input[type="password"]').forEach((input) => {
      if (input.dataset.eyeToggled) return;
      input.dataset.eyeToggled = "1";

      const wrapper = document.createElement("div");
      wrapper.style.cssText = "position:relative;";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const currentPaddingRight = window.getComputedStyle(input).paddingRight;
      input.style.paddingRight = "38px";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", "Show password");
      btn.innerHTML = EYE_OPEN;
      btn.style.cssText =
        "position:absolute; right:6px; top:50%; transform:translateY(-50%); width:28px; height:28px; " +
        "background:none; border:none; padding:0; margin:0; cursor:pointer; color:#6B7280; " +
        "display:flex; align-items:center; justify-content:center; line-height:0;";
      wrapper.appendChild(btn);

      btn.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        btn.innerHTML = showing ? EYE_OPEN : EYE_CLOSED;
        btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addToggles);
  } else {
    addToggles();
  }
})();
