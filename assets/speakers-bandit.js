(function () {
  const canvas = document.getElementById("speakerBanditCanvas");
  if (!canvas) return;

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (prefersReducedMotion) return;

  const ctx = canvas.getContext("2d");

  const symbols = [
    "●",
    "◆",
    "7",
    "★",
    "■"
  ];

  /*
   * These probabilities are hidden from UCB1.
   */
const hiddenProbabilities = [
  0.16,
  0.29,
  0.70,
  0.38,
  0.22
];

  const arms = hiddenProbabilities.map(
    (probability, index) => ({
      index,
      probability,
      pulls: 0,
      rewards: 0,
      estimate: 0,
      symbol: symbols[index],
      spinningSymbol: symbols[index],
      leverAmount: 0,
      flash: 0
    })
  );

  let width = 0;
  let height = 0;
  let dpr = 1;

  let activeArm = -1;
  let hoveredArm = -1;
  let recommendedArm = 0;

  let pullStartedAt = 0;
  let pullDuration = 1050;
  let pendingReward = 0;
  let lastSymbolChange = 0;

  let totalPulls = 0;
  let nextAutomaticPull = 0;

  /*
   * These areas surround the physical levers only.
   */
  let leverTargets = [];

  canvas.addEventListener(
    "pointerdown",
    handlePointerDown
  );

  canvas.addEventListener(
    "pointermove",
    handlePointerMove
  );

  canvas.addEventListener(
    "pointerleave",
    handlePointerLeave
  );

  window.addEventListener(
    "resize",
    resizeCanvas
  );

  resizeCanvas();

  nextAutomaticPull =
    performance.now() + 900;

  requestAnimationFrame(animate);

  function clamp(value, minimum, maximum) {
    return Math.max(
      minimum,
      Math.min(maximum, value)
    );
  }

  function randomBetween(minimum, maximum) {
    return (
      minimum +
      Math.random() *
        (maximum - minimum)
    );
  }

  function randomSymbol() {
    const index = Math.floor(
      Math.random() * symbols.length
    );

    return symbols[index];
  }

  function resizeCanvas() {
    const rect =
      canvas.getBoundingClientRect();

    width = rect.width || 900;
    height = rect.height || 400;

    dpr = Math.max(
      1,
      window.devicePixelRatio || 1
    );

    canvas.width =
      Math.floor(width * dpr);

    canvas.height =
      Math.floor(height * dpr);

    ctx.setTransform(
      dpr,
      0,
      0,
      dpr,
      0,
      0
    );
  }

  function roundedRectangle(
    context,
    x,
    y,
    boxWidth,
    boxHeight,
    radius
  ) {
    const r = Math.min(
      radius,
      boxWidth / 2,
      boxHeight / 2
    );

    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(
      x + boxWidth - r,
      y
    );

    context.quadraticCurveTo(
      x + boxWidth,
      y,
      x + boxWidth,
      y + r
    );

    context.lineTo(
      x + boxWidth,
      y + boxHeight - r
    );

    context.quadraticCurveTo(
      x + boxWidth,
      y + boxHeight,
      x + boxWidth - r,
      y + boxHeight
    );

    context.lineTo(
      x + r,
      y + boxHeight
    );

    context.quadraticCurveTo(
      x,
      y + boxHeight,
      x,
      y + boxHeight - r
    );

    context.lineTo(x, y + r);

    context.quadraticCurveTo(
      x,
      y,
      x + r,
      y
    );

    context.closePath();
  }

  function getPointerPosition(event) {
    const rect =
      canvas.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function hitTestLever(x, y) {
    for (const target of leverTargets) {
      if (
        x >= target.left &&
        x <= target.right &&
        y >= target.top &&
        y <= target.bottom
      ) {
        return target.index;
      }
    }

    return -1;
  }

  function handlePointerMove(event) {
    const pointer =
      getPointerPosition(event);

    hoveredArm = hitTestLever(
      pointer.x,
      pointer.y
    );

    canvas.style.cursor =
      hoveredArm >= 0 &&
      activeArm < 0
        ? "pointer"
        : "default";
  }

  function handlePointerLeave() {
    hoveredArm = -1;
    canvas.style.cursor = "default";
  }

  function handlePointerDown(event) {
    if (activeArm >= 0) return;

    const pointer =
      getPointerPosition(event);

    const clickedArm = hitTestLever(
      pointer.x,
      pointer.y
    );

    /*
     * Clicking outside the physical levers does nothing.
     */
    if (clickedArm < 0) return;

    beginPull(
      clickedArm,
      performance.now()
    );

    event.preventDefault();
  }

  function selectUCB1Arm() {
    /*
     * UCB1 tries every arm once before comparing scores.
     */
    const untestedArm = arms.find(
      (arm) => arm.pulls === 0
    );

    if (untestedArm) {
      return untestedArm.index;
    }

    const logarithmicTerm = Math.log(
      Math.max(1, totalPulls)
    );

    let selectedIndex = 0;
    let bestScore = -Infinity;

    for (const arm of arms) {
      const explorationBonus = Math.sqrt(
        (2 * logarithmicTerm) /
          arm.pulls
      );

      const score =
        arm.estimate +
        explorationBonus;

      if (score > bestScore) {
        bestScore = score;
        selectedIndex = arm.index;
      }
    }

    return selectedIndex;
  }

  function beginPull(index, now) {
    if (activeArm >= 0) return;

    activeArm = index;
    hoveredArm = -1;

    pullStartedAt = now;

    pullDuration = randomBetween(
      900,
      1150
    );

    pendingReward =
      Math.random() <
      arms[index].probability
        ? 1
        : 0;

    lastSymbolChange = now;

    canvas.style.cursor = "default";
  }

  function finishPull(now) {
    const arm = arms[activeArm];

    arm.pulls += 1;
    arm.rewards += pendingReward;

    arm.estimate =
      arm.rewards / arm.pulls;

    totalPulls += 1;

    if (pendingReward > 0) {
      arm.symbol = "7";
      arm.flash = 1;
    } else {
      let symbol = randomSymbol();

      if (symbol === "7") {
        symbol = "◆";
      }

      arm.symbol = symbol;
    }

    arm.spinningSymbol =
      arm.symbol;

    arm.leverAmount = 0;

    activeArm = -1;
    pendingReward = 0;

    recommendedArm =
      selectUCB1Arm();

    /*
     * Automatic UCB1 pulling continues after manual interaction.
     */
    nextAutomaticPull =
      now + randomBetween(1300, 1900);
  }

  function update(now) {
    for (const arm of arms) {
      arm.flash = Math.max(
        0,
        arm.flash - 0.018
      );
    }

    /*
     * Automatically pull the arm currently selected by UCB1.
     */
    if (
      activeArm < 0 &&
      now >= nextAutomaticPull
    ) {
      recommendedArm =
        selectUCB1Arm();

      beginPull(
        recommendedArm,
        now
      );

      return;
    }

    if (activeArm < 0) return;

    const arm = arms[activeArm];

    const progress = clamp(
      (now - pullStartedAt) /
        pullDuration,
      0,
      1
    );

    /*
     * Pull the lever down, hold briefly, and return.
     */
    if (progress < 0.25) {
      arm.leverAmount =
        progress / 0.25;
    } else if (progress < 0.52) {
      arm.leverAmount = 1;
    } else {
      arm.leverAmount =
        1 -
        (progress - 0.52) / 0.48;
    }

    arm.leverAmount = clamp(
      arm.leverAmount,
      0,
      1
    );

    if (
      progress < 0.82 &&
      now - lastSymbolChange > 70
    ) {
      arm.spinningSymbol =
        randomSymbol();

      lastSymbolChange = now;
    }

    if (progress >= 1) {
      finishPull(now);
    }
  }

  function getMachineGeometry() {
    const machineWidth = clamp(
      width * 0.45,
      310,
      520
    );

    const machineHeight = clamp(
      height * 0.7,
      240,
      315
    );

    return {
      x:
        width -
        machineWidth -
        Math.max(22, width * 0.045),

      y:
        (height - machineHeight) / 2,

      width: machineWidth,
      height: machineHeight
    };
  }

  function drawBackground() {
    ctx.clearRect(
      0,
      0,
      width,
      height
    );

    const gradient =
      ctx.createLinearGradient(
        width * 0.45,
        0,
        width,
        height
      );

    gradient.addColorStop(
      0,
      "rgba(15, 23, 42, 0)"
    );

    gradient.addColorStop(
      1,
      "rgba(15, 23, 42, 0.13)"
    );

    ctx.fillStyle = gradient;

    ctx.fillRect(
      0,
      0,
      width,
      height
    );
  }

  function drawCabinet(geometry) {
    const x = geometry.x;
    const y = geometry.y;

    const machineWidth =
      geometry.width;

    const machineHeight =
      geometry.height;

    ctx.save();

    ctx.fillStyle =
      "rgba(15, 23, 42, 0.68)";

    ctx.strokeStyle =
      "rgba(203, 213, 225, 0.18)";

    ctx.lineWidth = 1.4;

    ctx.shadowColor =
      "rgba(0, 0, 0, 0.18)";

    ctx.shadowBlur = 14;

    roundedRectangle(
      ctx,
      x,
      y,
      machineWidth,
      machineHeight,
      21
    );

    ctx.fill();

    ctx.shadowBlur = 0;

    roundedRectangle(
      ctx,
      x,
      y,
      machineWidth,
      machineHeight,
      21
    );

    ctx.stroke();

    /*
     * Simple upper panel.
     */
    ctx.fillStyle =
      "rgba(148, 163, 184, 0.08)";

    roundedRectangle(
      ctx,
      x + machineWidth * 0.06,
      y + machineHeight * 0.055,
      machineWidth * 0.88,
      machineHeight * 0.105,
      9
    );

    ctx.fill();

    /*
     * A small light indicates the arm currently recommended by UCB1.
     */
    const spacing =
      machineWidth * 0.1;

    const startingX =
      x +
      machineWidth / 2 -
      spacing * 2;

    for (
      let index = 0;
      index < arms.length;
      index += 1
    ) {
      const recommended =
        index === recommendedArm;

      const pulse =
        0.45 +
        0.2 *
          Math.sin(
            performance.now() * 0.003
          );

      ctx.fillStyle = recommended
        ? `rgba(125, 211, 252, ${pulse})`
        : "rgba(148, 163, 184, 0.2)";

      ctx.beginPath();

      ctx.arc(
        startingX +
          index * spacing,
        y + machineHeight * 0.108,
        recommended ? 4 : 3,
        0,
        Math.PI * 2
      );

      ctx.fill();
    }

    ctx.restore();
  }

  function drawArm(
    arm,
    index,
    geometry
  ) {
    const machineX = geometry.x;
    const machineY = geometry.y;

    const machineWidth =
      geometry.width;

    const machineHeight =
      geometry.height;

    const horizontalPadding =
      machineWidth * 0.055;

    const gap =
      machineWidth * 0.018;

    const usableWidth =
      machineWidth -
      horizontalPadding * 2 -
      gap * (arms.length - 1);

    const armWidth =
      usableWidth / arms.length;

    const x =
      machineX +
      horizontalPadding +
      index * (armWidth + gap);

    const selected =
      activeArm === index;

    const hovered =
      hoveredArm === index &&
      activeArm < 0;

    const recommended =
      recommendedArm === index;

    const reelY =
      machineY +
      machineHeight * 0.225;

    const reelHeight =
      machineHeight * 0.265;

    ctx.save();

    /*
     * Reel housing.
     */
    ctx.fillStyle = selected
      ? "rgba(125, 211, 252, 0.12)"
      : "rgba(226, 232, 240, 0.05)";

    ctx.strokeStyle = selected
      ? "rgba(186, 230, 253, 0.5)"
      : hovered
        ? "rgba(203, 213, 225, 0.42)"
        : "rgba(148, 163, 184, 0.18)";

    ctx.lineWidth =
      selected || hovered
        ? 1.6
        : 1;

    roundedRectangle(
      ctx,
      x,
      reelY,
      armWidth,
      reelHeight,
      8
    );

    ctx.fill();
    ctx.stroke();

    /*
     * Reel window.
     */
    const windowMargin =
      armWidth * 0.14;

    const windowX =
      x + windowMargin;

    const windowY =
      reelY +
      reelHeight * 0.15;

    const windowWidth =
      armWidth -
      windowMargin * 2;

    const windowHeight =
      reelHeight * 0.58;

    const reelGradient =
      ctx.createLinearGradient(
        windowX,
        windowY,
        windowX,
        windowY + windowHeight
      );

    reelGradient.addColorStop(
      0,
      "rgba(203, 213, 225, 0.75)"
    );

    reelGradient.addColorStop(
      0.5,
      "rgba(241, 245, 249, 0.88)"
    );

    reelGradient.addColorStop(
      1,
      "rgba(203, 213, 225, 0.75)"
    );

    ctx.fillStyle = reelGradient;

    roundedRectangle(
      ctx,
      windowX,
      windowY,
      windowWidth,
      windowHeight,
      6
    );

    ctx.fill();

    const displayedSymbol =
      selected
        ? arm.spinningSymbol
        : arm.symbol;

    ctx.fillStyle =
      "rgba(30, 41, 59, 0.82)";

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font =
      `800 ${clamp(
        armWidth * 0.45,
        20,
        34
      )}px Georgia, serif`;

    ctx.fillText(
      displayedSymbol,
      windowX + windowWidth / 2,
      windowY + windowHeight / 2
    );

    /*
     * Lever base.
     */
    const leverCenterX =
      x + armWidth / 2;

    const leverBaseY =
      machineY +
      machineHeight * 0.69;

    const leverTravel =
      machineHeight * 0.11;

    const leverTopY =
      leverBaseY -
      leverTravel +
      arm.leverAmount *
        leverTravel;

    const hoverOffset =
      hovered ? -3 : 0;

    const visibleLeverTopY =
      leverTopY + hoverOffset;

    ctx.fillStyle =
      "rgba(71, 85, 105, 0.82)";

    ctx.strokeStyle =
      "rgba(203, 213, 225, 0.24)";

    ctx.lineWidth = 1;

    roundedRectangle(
      ctx,
      leverCenterX -
        armWidth * 0.23,
      leverBaseY,
      armWidth * 0.46,
      machineHeight * 0.065,
      5
    );

    ctx.fill();
    ctx.stroke();

    /*
     * Lever stem.
     */
    ctx.strokeStyle = selected
      ? "rgba(186, 230, 253, 0.85)"
      : hovered
        ? "rgba(226, 232, 240, 0.88)"
        : "rgba(203, 213, 225, 0.58)";

    ctx.lineWidth = clamp(
      armWidth * 0.065,
      3,
      5
    );

    ctx.lineCap = "round";

    ctx.beginPath();

    ctx.moveTo(
      leverCenterX,
      leverBaseY +
        machineHeight * 0.018
    );

    ctx.lineTo(
      leverCenterX,
      visibleLeverTopY
    );

    ctx.stroke();

    /*
     * Lever knob.
     */
    const knobRadius = clamp(
      armWidth * 0.145,
      7,
      12
    );

    const pulse =
      0.5 +
      0.5 *
        Math.sin(
          performance.now() * 0.004 +
          index * 0.45
        );

    /*
     * Recommended arms pulse faintly.
     * Hovering creates a stronger outline.
     */
    if (recommended || hovered) {
      ctx.strokeStyle = hovered
        ? "rgba(226, 232, 240, 0.58)"
        : `rgba(125, 211, 252, ${
            0.1 + pulse * 0.14
          })`;

      ctx.lineWidth =
        hovered ? 2 : 1.4;

      ctx.beginPath();

      ctx.arc(
        leverCenterX,
        visibleLeverTopY,
        knobRadius + 5 + pulse * 2,
        0,
        Math.PI * 2
      );

      ctx.stroke();
    }

    const knobGradient =
      ctx.createRadialGradient(
        leverCenterX -
          knobRadius * 0.25,
        visibleLeverTopY -
          knobRadius * 0.25,
        1,
        leverCenterX,
        visibleLeverTopY,
        knobRadius
      );

    knobGradient.addColorStop(
      0,
      selected || hovered
        ? "rgba(241, 245, 249, 0.95)"
        : "rgba(203, 213, 225, 0.82)"
    );

    knobGradient.addColorStop(
      1,
      selected
        ? "rgba(14, 116, 144, 0.9)"
        : hovered
          ? "rgba(100, 116, 139, 0.95)"
          : "rgba(51, 65, 85, 0.95)"
    );

    ctx.fillStyle = knobGradient;

    ctx.beginPath();

    ctx.arc(
      leverCenterX,
      visibleLeverTopY,
      knobRadius,
      0,
      Math.PI * 2
    );

    ctx.fill();

    /*
     * Minimal arm number.
     */
    ctx.fillStyle =
      "rgba(148, 163, 184, 0.55)";

    ctx.font =
      `600 ${clamp(
        armWidth * 0.13,
        8,
        10
      )}px Segoe UI, sans-serif`;

    ctx.fillText(
      String(index + 1),
      leverCenterX,
      leverBaseY +
        machineHeight * 0.1
    );

    if (arm.flash > 0) {
      ctx.strokeStyle =
        `rgba(186, 230, 253, ${
          arm.flash * 0.5
        })`;

      ctx.lineWidth = 2;

      ctx.beginPath();

      ctx.arc(
        windowX +
          windowWidth / 2,
        windowY +
          windowHeight / 2,
        knobRadius +
          (1 - arm.flash) * 20,
        0,
        Math.PI * 2
      );

      ctx.stroke();
    }

    /*
     * Only this rectangle is clickable.
     * It tightly surrounds the visible lever.
     */
    const targetPadding = 9;

    leverTargets.push({
      index,

      left:
        leverCenterX -
        knobRadius -
        targetPadding,

      right:
        leverCenterX +
        knobRadius +
        targetPadding,

      top:
        visibleLeverTopY -
        knobRadius -
        targetPadding,

      bottom:
        leverBaseY +
        machineHeight * 0.07 +
        targetPadding
    });

    ctx.restore();
  }

  function drawInstruction(geometry) {
    const machineX = geometry.x;
    const machineY = geometry.y;

    const machineWidth =
      geometry.width;

    const machineHeight =
      geometry.height;

    ctx.save();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font =
      `600 ${clamp(
        machineHeight * 0.034,
        10,
        12
      )}px Segoe UI, sans-serif`;

    ctx.fillStyle =
      hoveredArm >= 0
        ? "rgba(226, 232, 240, 0.78)"
        : "rgba(148, 163, 184, 0.58)";

    ctx.fillText(
      activeArm >= 0
        ? "PULLING"
        : "AUTO UCB1  ·  CLICK A LEVER",
      machineX +
        machineWidth / 2,
      machineY +
        machineHeight * 0.91
    );

    ctx.restore();
  }

  function draw() {
    drawBackground();

    leverTargets = [];

    const geometry =
      getMachineGeometry();

    ctx.save();

    /*
     * Blend the machine into the hero background.
     */
    ctx.globalAlpha = 0.78;

    drawCabinet(geometry);

    arms.forEach((arm, index) => {
      drawArm(
        arm,
        index,
        geometry
      );
    });

    drawInstruction(geometry);

    ctx.restore();
  }

  function animate(now) {
    update(now);
    draw();

    requestAnimationFrame(animate);
  }
})();