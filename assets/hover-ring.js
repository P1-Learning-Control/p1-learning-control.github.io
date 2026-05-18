(function () {
  const ringSound = new Audio("assets/audio/ring.mp3");
  ringSound.volume = 0.35;

  let lastPlayedAt = 0;

  function playRingSound() {
    const now = Date.now();

    // Prevent sound from triggering too rapidly.
    if (now - lastPlayedAt < 120) return;
    lastPlayedAt = now;

    ringSound.currentTime = 0;
    ringSound.play().catch(() => {
      // Browser may block audio until the user clicks or presses a key once.
    });
  }

  function attachHoverSounds() {
    const clickableElements = document.querySelectorAll(
      "a, button, [role='button'], .menu a"
    );

    clickableElements.forEach((element) => {
      element.addEventListener("pointerenter", playRingSound);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachHoverSounds);
  } else {
    attachHoverSounds();
  }
})();