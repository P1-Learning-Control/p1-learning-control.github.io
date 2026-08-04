(function () {
  const canvas = document.getElementById("venueAgentCanvas");
  if (!canvas) return;

  const hero = canvas.closest(".venue-hero");
  if (!hero) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const palette = [
    "#7dd3fc",
    "#fbbf24",
    "#ffffff",
    "#fda4af",
    "#c4b5fd"
  ];

  const pointer = {
    x: 0,
    y: 0,
    inside: false,
    attracting: false
  };

  let width = 0;
  let height = 0;
  let deviceScale = 1;
  let agents = [];
  let groupTargets = [];
  let lastTime = performance.now();
  let elapsedTime = 0;

  hero.addEventListener("pointerenter", updatePointer);
  hero.addEventListener("pointermove", updatePointer);
  hero.addEventListener("pointerdown", updatePointer);
  hero.addEventListener("pointerleave", clearPointer);
  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();

  if (prefersReducedMotion) {
    drawScene();
    return;
  }

  requestAnimationFrame(animate);

  function randomBetween(minimum, maximum) {
    return minimum + Math.random() * (maximum - minimum);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function wrapAngle(angle) {
    let wrapped = angle;

    while (wrapped > Math.PI) wrapped -= 2 * Math.PI;
    while (wrapped < -Math.PI) wrapped += 2 * Math.PI;

    return wrapped;
  }

  function resizeCanvas() {
    const rectangle = canvas.getBoundingClientRect();
    const previousWidth = width || rectangle.width || 1;
    const previousHeight = height || rectangle.height || 1;

    width = Math.max(1, rectangle.width);
    height = Math.max(1, rectangle.height);
    deviceScale = Math.min(
      2,
      Math.max(1, window.devicePixelRatio || 1)
    );

    canvas.width = Math.round(width * deviceScale);
    canvas.height = Math.round(height * deviceScale);
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);

    if (agents.length === 0) {
      createWorld();
      return;
    }

    const scaleX = width / previousWidth;
    const scaleY = height / previousHeight;

    for (const agent of agents) {
      agent.x *= scaleX;
      agent.y *= scaleY;
    }

    for (const target of groupTargets) {
      target.x *= scaleX;
      target.y *= scaleY;
    }
  }

  function createWorld() {
    const groupCount = width < 560 ? 3 : width < 900 ? 4 : 5;
    const agentCount = width < 560 ? 36 : width < 900 ? 52 : 72;
    const clusterRadius = Math.min(width, height) * 0.105;

    groupTargets = [];
    agents = [];

    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const angle =
        (2 * Math.PI * groupIndex) / groupCount - Math.PI / 2;

      const target = {
        x: width * (0.5 + 0.29 * Math.cos(angle)),
        y: height * (0.5 + 0.23 * Math.sin(angle)),
        heading: angle + Math.PI / 2 + randomBetween(-0.4, 0.4),
        desiredHeading:
          angle + Math.PI / 2 + randomBetween(-0.4, 0.4),
        speed: randomBetween(6, 11),
        decisionTimer: randomBetween(1.6, 4.2),
        phase: randomBetween(0, Math.PI * 2)
      };

      groupTargets.push(target);
    }

    for (let index = 0; index < agentCount; index += 1) {
      const group = index % groupCount;
      const target = groupTargets[group];
      const radius = Math.sqrt(Math.random()) * clusterRadius;
      const angle = randomBetween(0, Math.PI * 2);

      agents.push({
        x: clamp(
          target.x + Math.cos(angle) * radius,
          18,
          width - 18
        ),
        y: clamp(
          target.y + Math.sin(angle) * radius,
          18,
          height - 18
        ),
        heading: randomBetween(-Math.PI, Math.PI),
        angularVelocity: 0,
        speed: randomBetween(13, 22),
        preferredSpeed: randomBetween(18, 29),
        size: randomBetween(5.5, 8.5),
        group,
        phase: randomBetween(0, Math.PI * 2)
      });
    }
  }

  function updatePointer(event) {
    const rectangle = hero.getBoundingClientRect();

    pointer.x = clamp(event.clientX - rectangle.left, 0, width);
    pointer.y = clamp(event.clientY - rectangle.top, 0, height);
    pointer.inside = true;
  }

  function clearPointer() {
    pointer.inside = false;
    pointer.attracting = false;
    hero.classList.remove("is-attracting");
  }

  function pointerInfluenceRadius() {
    return clamp(width * 0.2, 140, 240);
  }

  function pointerInfluenceFor(agent) {
    if (!pointer.inside) return 0;

    const distance = Math.hypot(
      pointer.x - agent.x,
      pointer.y - agent.y
    );
    const radius = pointerInfluenceRadius();

    if (distance >= radius) return 0;

    /*
     * Smooth local falloff: agents close to the cursor react strongly,
     * while agents near the edge of the radius barely react at all.
     */
    const normalized = 1 - distance / radius;
    return normalized * normalized * (3 - 2 * normalized);
  }

  function updatePointerMode() {
    if (!pointer.inside || agents.length === 0) {
      pointer.attracting = false;
      hero.classList.remove("is-attracting");
      return;
    }

    pointer.attracting = agents.some(
      (agent) => pointerInfluenceFor(agent) > 0.06
    );

    hero.classList.toggle("is-attracting", pointer.attracting);
  }

  function updateGroupTargets(deltaTime) {
    const marginX = Math.max(55, width * 0.08);
    const marginY = Math.max(45, height * 0.1);

    for (const target of groupTargets) {
      target.decisionTimer -= deltaTime;

      if (target.decisionTimer <= 0) {
        target.desiredHeading += randomBetween(-0.9, 0.9);
        target.decisionTimer = randomBetween(2.3, 5.5);
      }

      if (target.x < marginX) {
        target.desiredHeading = randomBetween(-0.65, 0.65);
      } else if (target.x > width - marginX) {
        target.desiredHeading = Math.PI + randomBetween(-0.65, 0.65);
      }

      if (target.y < marginY) {
        target.desiredHeading = Math.PI / 2 + randomBetween(-0.65, 0.65);
      } else if (target.y > height - marginY) {
        target.desiredHeading = -Math.PI / 2 + randomBetween(-0.65, 0.65);
      }

      const slowOscillation =
        0.16 * Math.sin(elapsedTime * 0.22 + target.phase);

      const headingError = wrapAngle(
        target.desiredHeading + slowOscillation - target.heading
      );

      target.heading = wrapAngle(
        target.heading + headingError * deltaTime * 0.38
      );

      target.x += Math.cos(target.heading) * target.speed * deltaTime;
      target.y += Math.sin(target.heading) * target.speed * deltaTime;

      target.x = clamp(target.x, marginX * 0.55, width - marginX * 0.55);
      target.y = clamp(target.y, marginY * 0.55, height - marginY * 0.55);
    }
  }

  function addDirection(vector, x, y, weight) {
    const length = Math.hypot(x, y);
    if (length < 0.0001) return;

    vector.x += (x / length) * weight;
    vector.y += (y / length) * weight;
  }

  function updateAgents(deltaTime) {
    const neighbourDistance = clamp(width * 0.085, 66, 102);
    const separationDistance = clamp(width * 0.026, 20, 31);
    const neighbourDistanceSquared = neighbourDistance * neighbourDistance;
    const separationDistanceSquared =
      separationDistance * separationDistance;
    const boundaryMargin = Math.max(34, Math.min(width, height) * 0.08);

    for (let agentIndex = 0; agentIndex < agents.length; agentIndex += 1) {
      const agent = agents[agentIndex];
      let neighbourCount = 0;
      let centreX = 0;
      let centreY = 0;
      let headingX = 0;
      let headingY = 0;
      let separationX = 0;
      let separationY = 0;

      for (
        let otherIndex = 0;
        otherIndex < agents.length;
        otherIndex += 1
      ) {
        if (otherIndex === agentIndex) continue;

        const other = agents[otherIndex];
        const dx = other.x - agent.x;
        const dy = other.y - agent.y;
        const distanceSquared = dx * dx + dy * dy;

        if (distanceSquared > neighbourDistanceSquared) continue;

        neighbourCount += 1;
        centreX += other.x;
        centreY += other.y;
        headingX += Math.cos(other.heading);
        headingY += Math.sin(other.heading);

        if (
          distanceSquared < separationDistanceSquared &&
          distanceSquared > 0.0001
        ) {
          const distance = Math.sqrt(distanceSquared);
          const strength =
            (separationDistance - distance) / separationDistance;

          separationX -= (dx / distance) * strength;
          separationY -= (dy / distance) * strength;
        }
      }

      const desired = { x: 0, y: 0 };
      const groupTarget = groupTargets[agent.group];
      const pointerInfluence = pointerInfluenceFor(agent);

      agent.pointerInfluence = pointerInfluence;

      /*
       * Every agent keeps following its own wandering group target.
       * The cursor adds only a local steering term, so distant groups
       * continue their independent random walk.
       */
      addDirection(
        desired,
        groupTarget.x - agent.x,
        groupTarget.y - agent.y,
        1.05
      );

      if (pointerInfluence > 0) {
        addDirection(
          desired,
          pointer.x - agent.x,
          pointer.y - agent.y,
          2.5 * pointerInfluence
        );
      }

      if (neighbourCount > 0) {
        centreX /= neighbourCount;
        centreY /= neighbourCount;

        addDirection(
          desired,
          centreX - agent.x,
          centreY - agent.y,
          0.58 - 0.18 * pointerInfluence
        );

        addDirection(
          desired,
          headingX,
          headingY,
          0.82 - 0.2 * pointerInfluence
        );
      }

      addDirection(
        desired,
        separationX,
        separationY,
        2.25 + 0.45 * pointerInfluence
      );

      const wanderingAngle =
        agent.phase + elapsedTime * (0.13 + 0.015 * agent.group);

      desired.x += Math.cos(wanderingAngle) * 0.13;
      desired.y += Math.sin(wanderingAngle * 0.91) * 0.13;

      if (agent.x < boundaryMargin) {
        desired.x += (boundaryMargin - agent.x) / boundaryMargin * 2.4;
      }

      if (agent.x > width - boundaryMargin) {
        desired.x -=
          (agent.x - (width - boundaryMargin)) / boundaryMargin * 2.4;
      }

      if (agent.y < boundaryMargin) {
        desired.y += (boundaryMargin - agent.y) / boundaryMargin * 2.4;
      }

      if (agent.y > height - boundaryMargin) {
        desired.y -=
          (agent.y - (height - boundaryMargin)) / boundaryMargin * 2.4;
      }

      if (Math.hypot(desired.x, desired.y) < 0.001) {
        desired.x = Math.cos(agent.heading);
        desired.y = Math.sin(agent.heading);
      }

      const desiredHeading = Math.atan2(desired.y, desired.x);
      const headingError = wrapAngle(desiredHeading - agent.heading);
      const maximumTurnRate = 2.1 + 0.9 * pointerInfluence;
      const commandedTurnRate = clamp(
        headingError * 3.25,
        -maximumTurnRate,
        maximumTurnRate
      );

      agent.angularVelocity +=
        (commandedTurnRate - agent.angularVelocity) *
        Math.min(1, deltaTime * 5.2);

      agent.heading = wrapAngle(
        agent.heading + agent.angularVelocity * deltaTime
      );

      const distanceToGroupTarget = Math.hypot(
        groupTarget.x - agent.x,
        groupTarget.y - agent.y
      );
      const distanceToPointer = Math.hypot(
        pointer.x - agent.x,
        pointer.y - agent.y
      );

      const wanderingSpeed =
        agent.preferredSpeed *
        clamp(0.65 + distanceToGroupTarget / 190, 0.7, 1.35);
      const followingSpeed = clamp(
        27 + distanceToPointer * 0.11,
        27,
        54
      );
      const targetSpeed =
        wanderingSpeed * (1 - pointerInfluence) +
        followingSpeed * pointerInfluence;

      agent.speed +=
        (targetSpeed - agent.speed) * Math.min(1, deltaTime * 1.8);

      /*
       * Unicycle dynamics:
       * x_dot = v cos(theta)
       * y_dot = v sin(theta)
       * theta_dot = omega
       */
      agent.x += Math.cos(agent.heading) * agent.speed * deltaTime;
      agent.y += Math.sin(agent.heading) * agent.speed * deltaTime;

      agent.x = clamp(agent.x, 10, width - 10);
      agent.y = clamp(agent.y, 10, height - 10);
    }
  }

  function drawConnections() {
    const connectionDistance = clamp(width * 0.047, 38, 58);
    const connectionDistanceSquared =
      connectionDistance * connectionDistance;

    context.save();
    context.lineWidth = 0.8;

    for (let first = 0; first < agents.length; first += 1) {
      for (let second = first + 1; second < agents.length; second += 1) {
        const firstAgent = agents[first];
        const secondAgent = agents[second];
        const dx = secondAgent.x - firstAgent.x;
        const dy = secondAgent.y - firstAgent.y;
        const distanceSquared = dx * dx + dy * dy;

        if (distanceSquared > connectionDistanceSquared) continue;

        const distance = Math.sqrt(distanceSquared);
        const alpha =
          0.012 + 0.065 * (1 - distance / connectionDistance);

        context.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        context.beginPath();
        context.moveTo(firstAgent.x, firstAgent.y);
        context.lineTo(secondAgent.x, secondAgent.y);
        context.stroke();
      }
    }

    context.restore();
  }

  function drawAgent(agent) {
    const size = agent.size;
    const colour = palette[agent.group % palette.length];

    context.save();
    context.translate(agent.x, agent.y);
    context.rotate(agent.heading);
    context.globalAlpha = 0.42 + 0.1 * (agent.pointerInfluence || 0);
    context.shadowColor = "rgba(0, 0, 0, 0.18)";
    context.shadowBlur = 5;
    context.shadowOffsetY = 1;
    context.fillStyle = colour;
    context.strokeStyle = "rgba(255, 255, 255, 0.48)";
    context.lineWidth = 0.9;

    context.beginPath();
    context.moveTo(size * 1.35, 0);
    context.lineTo(-size, size * 0.78);
    context.lineTo(-size, -size * 0.78);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  function drawPointerInfluence() {
    if (!pointer.inside) return;

    const radius = pointerInfluenceRadius();

    context.save();
    context.translate(pointer.x, pointer.y);
    context.strokeStyle = pointer.attracting
      ? "rgba(125, 211, 252, 0.28)"
      : "rgba(255, 255, 255, 0.1)";
    context.lineWidth = pointer.attracting ? 1.2 : 0.8;
    context.setLineDash([4, 8]);

    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.stroke();

    if (pointer.attracting) {
      context.fillStyle = "rgba(125, 211, 252, 0.42)";
      context.beginPath();
      context.arc(0, 0, 2.5, 0, Math.PI * 2);
      context.fill();
    }

    context.restore();
  }

  function drawScene() {
    context.clearRect(0, 0, width, height);
    drawConnections();

    for (const agent of agents) {
      drawAgent(agent);
    }

    drawPointerInfluence();
  }

  function animate(currentTime) {
    const deltaTime = clamp((currentTime - lastTime) / 1000, 0, 0.04);
    lastTime = currentTime;
    elapsedTime += deltaTime;

    updatePointerMode();
    updateGroupTargets(deltaTime);
    updateAgents(deltaTime);
    drawScene();

    requestAnimationFrame(animate);
  }
})();
