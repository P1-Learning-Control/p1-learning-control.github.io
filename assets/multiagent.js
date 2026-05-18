(function () {
  const canvas = document.getElementById("multiagentCanvas");
  if (!canvas) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return;

  const hero = canvas.closest(".hero");
  const ctx = canvas.getContext("2d");

  if (hero) {
    hero.style.cursor = "pointer";
    hero.title = "Click to disturb the agents";
  }

  canvas.style.cursor = "pointer";

  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastTime = null;
  let time = 0;

  const agents = [];
  const edges = [];
  let textTargets = [];

  let edgeRefreshTimer = 0;

  let disturbanceFlash = 0;
  let disturbanceX = 0;
  let disturbanceY = 0;

  const maxAgents = 200;
  const nearestNeighborDegree = 2;
  const randomExtraLinks = 10;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();

    width = rect.width || 900;
    height = rect.height || 400;
    dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getClickPosition(event) {
    const rect = canvas.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function disturbAgents(event) {
    if (event.target.closest && event.target.closest("a")) return;

    const click = getClickPosition(event);

    disturbanceX = click.x;
    disturbanceY = click.y;
    disturbanceFlash = 1;

    for (const agent of agents) {
      const dx = agent.x - click.x;
      const dy = agent.y - click.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-6;

      const globalAngle = randomBetween(0, 2 * Math.PI);
      const localStrength = clamp(1 - d / Math.max(width, height), 0.2, 1.0);

      const radialKick = randomBetween(85, 185) * localStrength;
      const randomKick = randomBetween(70, 170);

      agent.vx += radialKick * (dx / d);
      agent.vy += radialKick * (dy / d);

      agent.vx += randomKick * Math.cos(globalAngle);
      agent.vy += randomKick * Math.sin(globalAngle);

      agent.x += randomBetween(-18, 18) * localStrength;
      agent.y += randomBetween(-18, 18) * localStrength;

      agent.x = clamp(agent.x, width * 0.12, width * 0.98);
      agent.y = clamp(agent.y, height * 0.08, height * 0.92);
    }

    rebuildEdges();
  }

  if (hero) {
    hero.addEventListener("pointerdown", disturbAgents);
  } else {
    canvas.addEventListener("pointerdown", disturbAgents);
  }

  function buildOnlineTextTargets() {
    const offscreen = document.createElement("canvas");
    offscreen.width = Math.max(1, Math.floor(width));
    offscreen.height = Math.max(1, Math.floor(height));

    const offctx = offscreen.getContext("2d");

    offctx.clearRect(0, 0, offscreen.width, offscreen.height);

    const fontSize = Math.floor(Math.min(width * 0.115, height * 0.3));

    offctx.font = `800 ${fontSize}px "Segoe UI", Arial, sans-serif`;
    offctx.textAlign = "center";
    offctx.textBaseline = "middle";
    offctx.fillStyle = "#ffffff";

    const textX = width * 0.68;
    const textY = height * 0.54;

    offctx.fillText("ONLINE", textX, textY);

    const image = offctx.getImageData(
      0,
      0,
      offscreen.width,
      offscreen.height
    ).data;

    const rawPoints = [];
    const step = Math.max(6, Math.floor(fontSize * 0.105));

    for (let y = 0; y < offscreen.height; y += step) {
      for (let x = 0; x < offscreen.width; x += step) {
        const index = (y * offscreen.width + x) * 4;
        const alpha = image[index + 3];

        if (alpha > 50) {
          rawPoints.push({ x, y });
        }
      }
    }

    if (rawPoints.length <= maxAgents) {
      textTargets = rawPoints;
      return;
    }

    const reduced = [];
    const stride = Math.ceil(rawPoints.length / maxAgents);

    for (let i = 0; i < rawPoints.length; i += stride) {
      reduced.push(rawPoints[i]);

      if (reduced.length >= maxAgents) {
        break;
      }
    }

    textTargets = reduced;
  }

  function initializeAgents() {
    buildOnlineTextTargets();

    agents.length = 0;

    for (let i = 0; i < textTargets.length; i += 1) {
      agents.push({
        x: randomBetween(width * 0.32, width * 0.94),
        y: randomBetween(height * 0.16, height * 0.84),
        vx: randomBetween(-24, 24),
        vy: randomBetween(-24, 24),
        targetIndex: i
      });
    }

    rebuildEdges();
  }

  function rebuildEdges() {
    edges.length = 0;

    for (let i = 0; i < agents.length; i += 1) {
      const candidates = [];

      for (let j = 0; j < agents.length; j += 1) {
        if (i === j) continue;

        candidates.push({
          index: j,
          d: distance(agents[i], agents[j])
        });
      }

      candidates.sort((a, b) => a.d - b.d);

      for (let k = 0; k < nearestNeighborDegree; k += 1) {
        if (!candidates[k]) continue;

        const j = candidates[k].index;
        const a = Math.min(i, j);
        const b = Math.max(i, j);

        if (!edges.some((edge) => edge.a === a && edge.b === b)) {
          edges.push({ a, b });
        }
      }
    }

    for (let k = 0; k < randomExtraLinks; k += 1) {
      const a = Math.floor(Math.random() * agents.length);
      const b = Math.floor(Math.random() * agents.length);

      if (a !== b) {
        const i = Math.min(a, b);
        const j = Math.max(a, b);

        if (!edges.some((edge) => edge.a === i && edge.b === j)) {
          edges.push({ a: i, b: j });
        }
      }
    }
  }

  function formationTargets() {
    const driftX = 7 * Math.sin(time * 0.22);
    const driftY = 4 * Math.cos(time * 0.28);

    return textTargets.map((target) => ({
      x: target.x + driftX,
      y: target.y + driftY
    }));
  }

  function update(dt) {
    time += dt;
    edgeRefreshTimer += dt;

    disturbanceFlash = Math.max(0, disturbanceFlash - dt * 1.7);

    if (edgeRefreshTimer > 1.15) {
      edgeRefreshTimer = 0;
      rebuildEdges();
    }

    const targets = formationTargets();

    const consensusAccelerations = agents.map(() => ({
      ax: 0,
      ay: 0,
      count: 0
    }));

    for (const edge of edges) {
      const a = agents[edge.a];
      const b = agents[edge.b];

      consensusAccelerations[edge.a].ax +=
        0.55 * (b.vx - a.vx) +
        0.012 * (b.x - a.x);

      consensusAccelerations[edge.a].ay +=
        0.55 * (b.vy - a.vy) +
        0.012 * (b.y - a.y);

      consensusAccelerations[edge.a].count += 1;

      consensusAccelerations[edge.b].ax +=
        0.55 * (a.vx - b.vx) +
        0.012 * (a.x - b.x);

      consensusAccelerations[edge.b].ay +=
        0.55 * (a.vy - b.vy) +
        0.012 * (a.y - b.y);

      consensusAccelerations[edge.b].count += 1;
    }

    for (let i = 0; i < agents.length; i += 1) {
      const agent = agents[i];
      const target = targets[agent.targetIndex];
      const consensus = consensusAccelerations[i];

      let ax = 0;
      let ay = 0;

      if (consensus.count > 0) {
        ax += consensus.ax / consensus.count;
        ay += consensus.ay / consensus.count;
      }

      ax += 0.82 * (target.x - agent.x);
      ay += 0.82 * (target.y - agent.y);

      ax -= 1.35 * agent.vx;
      ay -= 1.35 * agent.vy;

      for (let j = 0; j < agents.length; j += 1) {
        if (i === j) continue;

        const other = agents[j];
        const dx = agent.x - other.x;
        const dy = agent.y - other.y;
        const d2 = dx * dx + dy * dy;

        if (d2 > 0.01 && d2 < 14 * 14) {
          const d = Math.sqrt(d2);
          const strength = 18 * (1 - d / 14);

          ax += strength * (dx / d);
          ay += strength * (dy / d);
        }
      }

      agent.vx += ax * dt;
      agent.vy += ay * dt;

      const speed = Math.sqrt(agent.vx * agent.vx + agent.vy * agent.vy);
      const maxSpeed = 115;

      if (speed > maxSpeed) {
        agent.vx = (agent.vx / speed) * maxSpeed;
        agent.vy = (agent.vy / speed) * maxSpeed;
      }

      agent.x += agent.vx * dt;
      agent.y += agent.vy * dt;

      agent.x = clamp(agent.x, width * 0.18, width * 0.97);
      agent.y = clamp(agent.y, height * 0.1, height * 0.9);
    }
  }

  function drawBackground() {
    ctx.clearRect(0, 0, width, height);

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "rgba(11, 18, 32, 0.30)");
    background.addColorStop(0.48, "rgba(30, 58, 138, 0.18)");
    background.addColorStop(1, "rgba(217, 119, 6, 0.14)");

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 1;

    const gap = 42;

    for (let x = -gap; x < width + gap; x += gap) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + width * 0.08, height);
      ctx.stroke();
    }

    for (let y = 0; y < height + gap; y += gap) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y - height * 0.08);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawTargetDots() {
    const targets = formationTargets();

    ctx.save();

    for (const target of targets) {
      ctx.fillStyle = "rgba(251, 191, 36, 0.16)";

      ctx.beginPath();
      ctx.arc(target.x, target.y, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawEdges() {
    ctx.save();

    for (const edge of edges) {
      const a = agents[edge.a];
      const b = agents[edge.b];

      const d = distance(a, b);
      const alpha = clamp(1 - d / 230, 0.025, 0.22);

      ctx.strokeStyle = `rgba(125, 211, 252, ${alpha})`;
      ctx.lineWidth = 1.1;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawDisturbanceRipple() {
    if (disturbanceFlash <= 0) return;

    ctx.save();

    ctx.strokeStyle = `rgba(244, 63, 94, ${disturbanceFlash * 0.55})`;
    ctx.lineWidth = 2.2;

    ctx.beginPath();
    ctx.arc(
      disturbanceX,
      disturbanceY,
      24 + (1 - disturbanceFlash) * 110,
      0,
      Math.PI * 2
    );
    ctx.stroke();

    ctx.strokeStyle = `rgba(251, 191, 36, ${disturbanceFlash * 0.35})`;
    ctx.lineWidth = 1.4;

    ctx.beginPath();
    ctx.arc(
      disturbanceX,
      disturbanceY,
      46 + (1 - disturbanceFlash) * 150,
      0,
      Math.PI * 2
    );
    ctx.stroke();

    ctx.restore();
  }

  function drawAgents() {
    ctx.save();

    for (const agent of agents) {
      const gradient = ctx.createRadialGradient(
        agent.x - 2,
        agent.y - 2,
        1,
        agent.x,
        agent.y,
        8.5
      );

      gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
      gradient.addColorStop(0.42, "rgba(125, 211, 252, 0.96)");
      gradient.addColorStop(1, "rgba(29, 78, 216, 0.92)");

      ctx.fillStyle = gradient;

      ctx.beginPath();
      ctx.arc(agent.x, agent.y, 5.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 0.8;

      ctx.beginPath();
      ctx.arc(agent.x, agent.y, 8.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function draw() {
    drawBackground();
    drawTargetDots();
    drawEdges();
    drawDisturbanceRipple();
    drawAgents();
  }

  function animate(now) {
    if (lastTime === null) {
      lastTime = now;
    }

    const dt = Math.min(0.03, (now - lastTime) / 1000);
    lastTime = now;

    update(dt);
    draw();

    requestAnimationFrame(animate);
  }

  resizeCanvas();
  initializeAgents();

  window.addEventListener("resize", function () {
    resizeCanvas();
    initializeAgents();
  });

  requestAnimationFrame(animate);
})();