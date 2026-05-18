(function () {
  const grid = document.querySelector("[data-randomize-members]");
  if (!grid) return;

  const members = Array.from(grid.children);

  for (let index = members.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [members[index], members[swapIndex]] = [members[swapIndex], members[index]];
  }

  members.forEach((member) => grid.appendChild(member));
})();

(function () {
  const canvas = document.getElementById("pendulumCanvas");
  if (!canvas) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return;

  const hero = canvas.closest(".hero");
  const ctx = canvas.getContext("2d");

  if (hero) {
    hero.style.cursor = "pointer";
    hero.title = "Click to disturb the pendulum";
  }

  canvas.style.cursor = "pointer";

  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastTime = null;

  const trackLimit = 2.8;
  const desiredCartPosition = 2.4;

  let cartPosition = randomBetween(-trackLimit * 0.55, trackLimit * 0.55);
  let cartVelocity = 0.0;
  let theta = Math.PI - 0.18;
  let thetaVelocity = 0.0;

  const gravity = 9.81;
  const cartMass = 1.0;
  const poleMass = 0.18;
  const poleLength = 0.9;
  const totalMass = cartMass + poleMass;
  const poleMassLength = poleMass * poleLength;

  const maxControlForce = 115;
  const maxTotalForce = 170;

  const horizonSteps = 30;
  const planningDt = 0.035;
  const ilqrIterations = 5;

  const stageWeights = {
    cart: 0.55,
    cartVelocity: 0.08,
    angle: 18.0,
    angularVelocity: 1.15,
    control: 0.0007,
    barrier: 1.1
  };

  const terminalWeights = {
    cart: 4.0,
    cartVelocity: 0.6,
    angle: 85.0,
    angularVelocity: 7.5,
    barrier: 5.0
  };

  let controlPlan = null;

  let disturbanceForce = 0;
  let disturbanceTimeLeft = 0;
  let disturbanceFlash = 0;

  const bobTrail = [];
  const maxTrailLength = 140;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapAngle(angle) {
    let wrapped = angle;

    while (wrapped > Math.PI) {
      wrapped -= 2 * Math.PI;
    }

    while (wrapped < -Math.PI) {
      wrapped += 2 * Math.PI;
    }

    return wrapped;
  }

  function angleDifference(a, b) {
    return wrapAngle(a - b);
  }

  function stateDifference(a, b) {
    return [
      a[0] - b[0],
      a[1] - b[1],
      angleDifference(a[2], b[2]),
      a[3] - b[3]
    ];
  }

  function dot(a, b) {
    let value = 0;

    for (let i = 0; i < a.length; i += 1) {
      value += a[i] * b[i];
    }

    return value;
  }

  function addToState(state, index, amount) {
    const copy = state.slice();
    copy[index] += amount;

    if (index === 2) {
      copy[index] = wrapAngle(copy[index]);
    }

    return copy;
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

  function applyDisturbance(event) {
    if (event.target.closest && event.target.closest("a")) return;

    disturbanceForce = randomBetween(-130, 130);
    disturbanceTimeLeft = randomBetween(0.2, 0.36);

    cartVelocity += randomBetween(-2.8, 2.8);
    thetaVelocity += randomBetween(-4.6, 4.6);
    theta += randomBetween(-0.28, 0.28);

    disturbanceFlash = 1;
    controlPlan = null;
  }

  if (hero) {
    hero.addEventListener("pointerdown", applyDisturbance);
  } else {
    canvas.addEventListener("pointerdown", applyDisturbance);
  }

  function currentState() {
    return [
      cartPosition,
      cartVelocity,
      wrapAngle(theta),
      thetaVelocity
    ];
  }

  function cartPoleNext(state, controlForce, dt, enforceRail) {
    let x = state[0];
    let xDot = state[1];
    let angle = wrapAngle(state[2]);
    let angleDot = state[3];

    const force = clamp(controlForce, -maxControlForce, maxControlForce);

    const sinTheta = Math.sin(angle);
    const cosTheta = Math.cos(angle);

    const temp =
      (force + poleMassLength * angleDot * angleDot * sinTheta) /
      totalMass;

    const thetaAcceleration =
      (gravity * sinTheta - cosTheta * temp) /
      (poleLength * (4 / 3 - (poleMass * cosTheta * cosTheta) / totalMass));

    const cartAcceleration =
      temp - (poleMassLength * thetaAcceleration * cosTheta) / totalMass;

    xDot += cartAcceleration * dt;
    x += xDot * dt;

    angleDot += thetaAcceleration * dt;
    angle += angleDot * dt;
    angle = wrapAngle(angle);

    if (enforceRail) {
      if (x > trackLimit) {
        x = trackLimit;
        xDot = Math.min(0, xDot) * 0.25;
      }

      if (x < -trackLimit) {
        x = -trackLimit;
        xDot = Math.max(0, xDot) * 0.25;
      }
    }

    return [x, xDot, angle, angleDot];
  }

  function barrierCostDerivatives(x, weight) {
    const effectiveLimit = trackLimit * 0.985;
    const epsilon = 0.045;

    const distanceRight = Math.max(epsilon, effectiveLimit - x);
    const distanceLeft = Math.max(epsilon, effectiveLimit + x);

    let cost =
      -weight *
      (Math.log(distanceRight / effectiveLimit) +
        Math.log(distanceLeft / effectiveLimit));

    let gradient =
      weight *
      (1 / distanceRight - 1 / distanceLeft);

    let hessian =
      weight *
      (1 / (distanceRight * distanceRight) +
        1 / (distanceLeft * distanceLeft));

    const violation = Math.max(0, Math.abs(x) - effectiveLimit);

    if (violation > 0) {
      const sign = Math.sign(x);

      cost += 600 * violation * violation;
      gradient += sign * 1200 * violation;
      hessian += 1200;
    }

    return { cost, gradient, hessian };
  }

  function stageCost(state, controlForce, terminal) {
    const weights = terminal ? terminalWeights : stageWeights;

    const x = state[0];
    const xDot = state[1];
    const angle = wrapAngle(state[2]);
    const angleDot = state[3];

    const cartError = x - desiredCartPosition;
    const barrier = barrierCostDerivatives(x, weights.barrier);

    let cost =
      weights.cart * cartError * cartError +
      weights.cartVelocity * xDot * xDot +
      weights.angle * angle * angle +
      weights.angularVelocity * angleDot * angleDot +
      barrier.cost;

    if (!terminal) {
      cost += stageWeights.control * controlForce * controlForce;
    }

    return cost;
  }

  function stageCostDerivatives(state, controlForce, terminal) {
    const weights = terminal ? terminalWeights : stageWeights;

    const x = state[0];
    const xDot = state[1];
    const angle = wrapAngle(state[2]);
    const angleDot = state[3];

    const cartError = x - desiredCartPosition;
    const barrier = barrierCostDerivatives(x, weights.barrier);

    const lx = [
      2 * weights.cart * cartError + barrier.gradient,
      2 * weights.cartVelocity * xDot,
      2 * weights.angle * angle,
      2 * weights.angularVelocity * angleDot
    ];

    const lxx = [
      [2 * weights.cart + barrier.hessian, 0, 0, 0],
      [0, 2 * weights.cartVelocity, 0, 0],
      [0, 0, 2 * weights.angle, 0],
      [0, 0, 0, 2 * weights.angularVelocity]
    ];

    const lu = terminal ? 0 : 2 * stageWeights.control * controlForce;
    const luu = terminal ? 0 : 2 * stageWeights.control;

    return { lx, lxx, lu, luu };
  }

  function trajectoryCost(states, controls) {
    let cost = 0;

    for (let k = 0; k < controls.length; k += 1) {
      cost += stageCost(states[k], controls[k], false);
    }

    cost += stageCost(states[states.length - 1], 0, true);

    return cost;
  }

  function rollout(initialState, controls) {
    const states = [initialState.slice()];

    for (let k = 0; k < controls.length; k += 1) {
      const next = cartPoleNext(states[k], controls[k], planningDt, false);
      states.push(next);
    }

    return states;
  }

  function linearizeDynamics(state, controlForce) {
    const stateEps = [0.002, 0.004, 0.002, 0.004];
    const controlEps = 0.08;

    const A = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ];

    for (let column = 0; column < 4; column += 1) {
      const plusState = addToState(state, column, stateEps[column]);
      const minusState = addToState(state, column, -stateEps[column]);

      const plusNext = cartPoleNext(plusState, controlForce, planningDt, false);
      const minusNext = cartPoleNext(minusState, controlForce, planningDt, false);

      const diff = stateDifference(plusNext, minusNext);

      for (let row = 0; row < 4; row += 1) {
        A[row][column] = diff[row] / (2 * stateEps[column]);
      }
    }

    const plusControl = cartPoleNext(
      state,
      controlForce + controlEps,
      planningDt,
      false
    );

    const minusControl = cartPoleNext(
      state,
      controlForce - controlEps,
      planningDt,
      false
    );

    const controlDiff = stateDifference(plusControl, minusControl);
    const B = controlDiff.map((value) => value / (2 * controlEps));

    return { A, B };
  }

  function matVec(matrix, vector) {
    return matrix.map((row) => dot(row, vector));
  }

  function transposeMatVec(matrix, vector) {
    const result = new Array(matrix[0].length).fill(0);

    for (let row = 0; row < matrix.length; row += 1) {
      for (let col = 0; col < matrix[row].length; col += 1) {
        result[col] += matrix[row][col] * vector[row];
      }
    }

    return result;
  }

  function atMa(A, M) {
    const result = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ];

    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        let value = 0;

        for (let p = 0; p < 4; p += 1) {
          for (let q = 0; q < 4; q += 1) {
            value += A[p][i] * M[p][q] * A[q][j];
          }
        }

        result[i][j] = value;
      }
    }

    return result;
  }

  function bTMA(B, M, A) {
    const result = [0, 0, 0, 0];

    for (let j = 0; j < 4; j += 1) {
      let value = 0;

      for (let p = 0; p < 4; p += 1) {
        for (let q = 0; q < 4; q += 1) {
          value += B[p] * M[p][q] * A[q][j];
        }
      }

      result[j] = value;
    }

    return result;
  }

  function symmetrize(matrix) {
    for (let i = 0; i < 4; i += 1) {
      for (let j = i + 1; j < 4; j += 1) {
        const value = 0.5 * (matrix[i][j] + matrix[j][i]);
        matrix[i][j] = value;
        matrix[j][i] = value;
      }
    }

    return matrix;
  }

  function energySwingSeed(state, stepIndex) {
    const x = state[0];
    const xDot = state[1];
    const angle = wrapAngle(state[2]);
    const angleDot = state[3];

    const energy =
      0.5 * Math.pow(poleLength * angleDot, 2) +
      gravity * poleLength * (Math.cos(angle) - 1);

    const pump =
      18.0 * angleDot * Math.cos(angle) * energy;

    const probing =
      24.0 * Math.sin(performance.now() * 0.0025 + 0.45 * stepIndex);

    const centering =
      -2.0 * (x - desiredCartPosition) -
      1.1 * xDot;

    const barrier = barrierCostDerivatives(x, 0.45);

    return clamp(
      pump + probing + centering - 3.0 * barrier.gradient,
      -maxControlForce,
      maxControlForce
    );
  }

  function initialControlSequence(state) {
    const controls = [];
    let simulated = state.slice();

    for (let k = 0; k < horizonSteps; k += 1) {
      const u = energySwingSeed(simulated, k);
      controls.push(u);
      simulated = cartPoleNext(simulated, u, planningDt, false);
    }

    return controls;
  }

  function optimizeWithILQR(initialState, initialControls) {
    let controls = initialControls.slice();
    let states = rollout(initialState, controls);

    let bestCost = trajectoryCost(states, controls);

    for (let iteration = 0; iteration < ilqrIterations; iteration += 1) {
      const feedforward = new Array(horizonSteps);
      const feedback = new Array(horizonSteps);

      const terminal = stageCostDerivatives(
        states[states.length - 1],
        0,
        true
      );

      let Vx = terminal.lx.slice();
      let Vxx = terminal.lxx.map((row) => row.slice());

      let backwardPassFailed = false;

      for (let k = horizonSteps - 1; k >= 0; k -= 1) {
        const state = states[k];
        const control = controls[k];

        const { A, B } = linearizeDynamics(state, control);
        const derivatives = stageCostDerivatives(state, control, false);

        const lx = derivatives.lx;
        const lxx = derivatives.lxx;
        const lu = derivatives.lu;
        const luu = derivatives.luu;

        const AtVx = transposeMatVec(A, Vx);
        const BVx = dot(B, Vx);

        const Qx = lx.map((value, i) => value + AtVx[i]);
        const Qu = lu + BVx;

        const AtVxxA = atMa(A, Vxx);
        const Qxx = [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0]
        ];

        for (let i = 0; i < 4; i += 1) {
          for (let j = 0; j < 4; j += 1) {
            Qxx[i][j] = lxx[i][j] + AtVxxA[i][j];
          }
        }

        const VxxB = matVec(Vxx, B);
        let Quu = luu + dot(B, VxxB) + 1e-4;
        const Qux = bTMA(B, Vxx, A);

        if (!Number.isFinite(Quu) || Quu <= 1e-8) {
          backwardPassFailed = true;
          break;
        }

        const kff = -Qu / Quu;
        const K = Qux.map((value) => -value / Quu);

        feedforward[k] = kff;
        feedback[k] = K;

        const newVx = new Array(4).fill(0);
        const newVxx = [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0]
        ];

        for (let i = 0; i < 4; i += 1) {
          newVx[i] =
            Qx[i] +
            K[i] * Quu * kff +
            K[i] * Qu +
            Qux[i] * kff;
        }

        for (let i = 0; i < 4; i += 1) {
          for (let j = 0; j < 4; j += 1) {
            newVxx[i][j] =
              Qxx[i][j] +
              K[i] * Quu * K[j] +
              K[i] * Qux[j] +
              Qux[i] * K[j];
          }
        }

        Vx = newVx;
        Vxx = symmetrize(newVxx);
      }

      if (backwardPassFailed) {
        break;
      }

      const lineSearch = [1.0, 0.55, 0.25, 0.1];
      let accepted = false;

      for (const alpha of lineSearch) {
        const candidateControls = [];
        const candidateStates = [initialState.slice()];

        for (let k = 0; k < horizonSteps; k += 1) {
          const dx = stateDifference(candidateStates[k], states[k]);

          const correction =
            alpha * feedforward[k] +
            dot(feedback[k], dx);

          const u = clamp(
            controls[k] + correction,
            -maxControlForce,
            maxControlForce
          );

          candidateControls.push(u);

          candidateStates.push(
            cartPoleNext(candidateStates[k], u, planningDt, false)
          );
        }

        const candidateCost = trajectoryCost(candidateStates, candidateControls);

        if (candidateCost < bestCost && Number.isFinite(candidateCost)) {
          controls = candidateControls;
          states = candidateStates;
          bestCost = candidateCost;
          accepted = true;
          break;
        }
      }

      if (!accepted) {
        break;
      }
    }

    return controls;
  }

  function computeILQRControl() {
    const state = currentState();
    const angle = wrapAngle(state[2]);

    let controls;

    if (!controlPlan || controlPlan.length !== horizonSteps) {
      controls = initialControlSequence(state);
    } else {
      controls = controlPlan.slice();

      if (Math.abs(angle) > 0.9) {
        const seed = initialControlSequence(state);

        for (let k = 0; k < horizonSteps; k += 1) {
          controls[k] = 0.65 * controls[k] + 0.35 * seed[k];
        }
      }
    }

    const optimizedControls = optimizeWithILQR(state, controls);

    const firstControl = optimizedControls[0];

    controlPlan = optimizedControls.slice(1);
    controlPlan.push(optimizedControls[optimizedControls.length - 1]);

    return clamp(firstControl, -maxControlForce, maxControlForce);
  }

  function stepDynamics(dt, controlForce) {
    let externalForce = 0;

    if (disturbanceTimeLeft > 0) {
      externalForce = disturbanceForce;
      disturbanceTimeLeft -= dt;
    } else {
      disturbanceForce = 0;
    }

    const totalForce = clamp(
      controlForce + externalForce,
      -maxTotalForce,
      maxTotalForce
    );

    const next = cartPoleNext(
      currentState(),
      totalForce,
      dt,
      true
    );

    cartPosition = next[0];
    cartVelocity = next[1];
    theta = next[2];
    thetaVelocity = next[3];

    disturbanceFlash = Math.max(0, disturbanceFlash - dt * 1.65);
  }

  function modelXToScreenX(x) {
    const usableWidth = width * 0.41;
    return width * 0.5 + (x / trackLimit) * usableWidth;
  }

  function drawBackground() {
    ctx.clearRect(0, 0, width, height);

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "rgba(11, 18, 32, 0.30)");
    background.addColorStop(0.5, "rgba(30, 58, 138, 0.18)");
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

  function drawPendulum() {
    const scale = Math.min(width, height);

    const railY = height * 0.72;
    const cartCenterX = modelXToScreenX(cartPosition);

    const cartWidth = clamp(scale * 0.23, 94, 150);
    const cartHeight = clamp(scale * 0.075, 30, 44);

    const pivotX = cartCenterX;
    const pivotY = railY - cartHeight * 0.85;

    const pendulumLength = clamp(scale * 0.29, 102, 154);

    const bobX = pivotX + pendulumLength * Math.sin(theta);
    const bobY = pivotY - pendulumLength * Math.cos(theta);

    bobTrail.push({ x: bobX, y: bobY });

    if (bobTrail.length > maxTrailLength) {
      bobTrail.shift();
    }

    ctx.save();

    for (let i = 1; i < bobTrail.length; i += 1) {
      const previous = bobTrail[i - 1];
      const current = bobTrail[i];
      const age = i / bobTrail.length;

      ctx.strokeStyle = `rgba(125, 211, 252, ${0.04 + age * 0.38})`;
      ctx.lineWidth = 0.8 + age * 1.8;
      ctx.lineCap = "round";

      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(current.x, current.y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(modelXToScreenX(-trackLimit), railY);
    ctx.lineTo(modelXToScreenX(trackLimit), railY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(251, 191, 36, 0.58)";
    ctx.lineWidth = 1.6;

    ctx.beginPath();
    ctx.arc(pivotX, pivotY - pendulumLength, 18, 0, Math.PI * 2);
    ctx.stroke();

    if (disturbanceFlash > 0) {
      ctx.strokeStyle = `rgba(244, 63, 94, ${disturbanceFlash * 0.55})`;
      ctx.lineWidth = 2.2;

      ctx.beginPath();
      ctx.arc(pivotX, pivotY, 24 + (1 - disturbanceFlash) * 75, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(bobX, bobY, 16 + (1 - disturbanceFlash) * 58, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.beginPath();
    ctx.ellipse(cartCenterX, railY + 21, cartWidth * 0.5, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    const cartX = cartCenterX - cartWidth / 2;
    const cartY = railY - cartHeight / 2;

    ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
    ctx.lineWidth = 1.5;

    roundRect(ctx, cartX, cartY, cartWidth, cartHeight, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.76)";

    ctx.beginPath();
    ctx.arc(cartCenterX - cartWidth * 0.29, railY + cartHeight * 0.48, 6.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cartCenterX + cartWidth * 0.29, railY + cartHeight * 0.48, 6.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.94)";
    ctx.lineWidth = 4.3;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(bobX, bobY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(34, 211, 238, 0.74)";
    ctx.lineWidth = 1.4;

    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(bobX, bobY);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, 6.2, 0, Math.PI * 2);
    ctx.fill();

    const bobGradient = ctx.createRadialGradient(
      bobX - 4,
      bobY - 5,
      2,
      bobX,
      bobY,
      18
    );

    bobGradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    bobGradient.addColorStop(0.45, "rgba(251, 191, 36, 0.96)");
    bobGradient.addColorStop(1, "rgba(217, 119, 6, 0.9)");

    ctx.fillStyle = bobGradient;
    ctx.beginPath();
    ctx.arc(bobX, bobY, 14.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function animate(now) {
    if (lastTime === null) {
      lastTime = now;
    }

    const dt = Math.min(0.024, (now - lastTime) / 1000);
    lastTime = now;

    const controlForce = computeILQRControl();

    const substeps = 3;
    const subDt = dt / substeps;

    for (let i = 0; i < substeps; i += 1) {
      stepDynamics(subDt, controlForce);
    }

    drawBackground();
    drawPendulum();

    requestAnimationFrame(animate);
  }

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  requestAnimationFrame(animate);
})();