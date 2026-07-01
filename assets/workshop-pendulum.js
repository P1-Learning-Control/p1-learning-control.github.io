(function () {
  const canvas = document.getElementById("workshopPendulumCanvas");
  if (!canvas) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return;

  const ctx = canvas.getContext("2d");

  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastTime = null;

  const trackLimit = 28.0;
  const desiredBoatPosition = 0.0;

  let boatPosition = randomBetween(-trackLimit * 0.35, trackLimit * 0.35);
  let boatVelocity = 0.0;
  let theta = Math.PI - 0.18;
  let thetaVelocity = 0.0;

  const gravity = 9.81;
  const cartMass = 1.0;
  const poleMass = 0.18;
  const poleLength = 0.9;
  const totalMass = cartMass + poleMass;
  const poleMassLength = poleMass * poleLength;

  const maxControlForce = 170;
  const maxTotalForce = 300;

  const horizonSteps = 32;
  const planningDt = 0.035;
  const ilqrIterations = 5;

  const stageWeights = {
    cart: 0.025,
    cartVelocity: 0.035,
    angle: 18.0,
    angularVelocity: 1.1,
    control: 0.0007,
    barrier: 0.02
  };

  const terminalWeights = {
    cart: 0.08,
    cartVelocity: 0.08,
    angle: 84.0,
    angularVelocity: 7.0,
    barrier: 0.08
  };

  let controlPlan = null;

  let disturbanceForce = 0;
  let disturbanceDirection = 1;
  let disturbanceTimeLeft = 0;
  let disturbanceDuration = 0;
  let disturbanceFlash = 0;

  const bobTrail = [];
  const maxTrailLength = 90;

  canvas.addEventListener("pointerdown", applyDisturbance);
  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();
  requestAnimationFrame(animate);

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

    width = rect.width || 560;
    height = rect.height || 150;
    dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function applyDisturbance(event) {
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const boatScreenX = modelXToScreenX(boatPosition);

    disturbanceDirection = clickX >= boatScreenX ? 1 : -1;

    /*
      Disturbance is now a real temporary force on the boat/base.
      It is not an instantaneous velocity kick, and it does not directly
      modify the pendulum angle or angular velocity.
    */
    disturbanceForce = disturbanceDirection * randomBetween(85, 145);
    disturbanceDuration = randomBetween(0.25, 0.70);
    disturbanceTimeLeft = disturbanceDuration;
    disturbanceFlash = 1;

    controlPlan = null;

    event.preventDefault();
  }

  function currentState() {
    return [
      boatPosition,
      boatVelocity,
      wrapAngle(theta),
      thetaVelocity
    ];
  }

  function cartPoleNext(state, forceInput, dt, enforceRail) {
    let x = state[0];
    let xDot = state[1];
    let angle = wrapAngle(state[2]);
    let angleDot = state[3];

    const force = clamp(forceInput, -maxTotalForce, maxTotalForce);
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
    const epsilon = 0.07;

    const distanceRight = Math.max(epsilon, effectiveLimit - x);
    const distanceLeft = Math.max(epsilon, effectiveLimit + x);

    let cost =
      -weight *
      (Math.log(distanceRight / effectiveLimit) +
        Math.log(distanceLeft / effectiveLimit));

    let gradient = weight * (1 / distanceRight - 1 / distanceLeft);

    let hessian =
      weight *
      (1 / (distanceRight * distanceRight) +
        1 / (distanceLeft * distanceLeft));

    const violation = Math.max(0, Math.abs(x) - effectiveLimit);

    if (violation > 0) {
      const sign = Math.sign(x);
      cost += 700 * violation * violation;
      gradient += sign * 1400 * violation;
      hessian += 1400;
    }

    return { cost, gradient, hessian };
  }

  function stageCost(state, controlForce, terminal) {
    const weights = terminal ? terminalWeights : stageWeights;

    const x = state[0];
    const xDot = state[1];
    const angle = wrapAngle(state[2]);
    const angleDot = state[3];

    const cartError = x - desiredBoatPosition;
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

    const cartError = x - desiredBoatPosition;
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
    const stateEps = [0.003, 0.004, 0.002, 0.004];
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

    const plusControl = cartPoleNext(state, controlForce + controlEps, planningDt, false);
    const minusControl = cartPoleNext(state, controlForce - controlEps, planningDt, false);

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

    const pump = 18.0 * angleDot * Math.cos(angle) * energy;
    const probing = 22.0 * Math.sin(performance.now() * 0.0024 + 0.45 * stepIndex);
    const centering = -0.35 * (x - desiredBoatPosition) - 0.45 * xDot;
    const barrier = barrierCostDerivatives(x, 0.01);

    return clamp(
      pump + probing + centering - 0.8 * barrier.gradient,
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

      const terminal = stageCostDerivatives(states[states.length - 1], 0, true);

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
        const Quu = luu + dot(B, VxxB) + 1e-4;
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

      if (backwardPassFailed) break;

      const lineSearch = [1.0, 0.55, 0.25, 0.1];
      let accepted = false;

      for (const alpha of lineSearch) {
        const candidateControls = [];
        const candidateStates = [initialState.slice()];

        for (let k = 0; k < horizonSteps; k += 1) {
          const dx = stateDifference(candidateStates[k], states[k]);
          const correction = alpha * feedforward[k] + dot(feedback[k], dx);

          const u = clamp(
            controls[k] + correction,
            -maxControlForce,
            maxControlForce
          );

          candidateControls.push(u);
          candidateStates.push(cartPoleNext(candidateStates[k], u, planningDt, false));
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

      if (!accepted) break;
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
      disturbanceTimeLeft = Math.max(0, disturbanceTimeLeft - dt);
      disturbanceFlash = 1;
    } else {
      disturbanceForce = 0;
      disturbanceFlash = Math.max(0, disturbanceFlash - dt * 2.1);
    }

    const totalForce = clamp(
      controlForce + externalForce,
      -maxTotalForce,
      maxTotalForce
    );

    const next = cartPoleNext(currentState(), totalForce, dt, true);

    boatPosition = next[0];
    boatVelocity = next[1];
    theta = next[2];
    thetaVelocity = next[3];
  }

  function modelXToScreenX(x) {
    const halfRange = width * 0.48;
    return width * 0.5 + (x / trackLimit) * halfRange;
  }

  function drawBackground() {
    ctx.clearRect(0, 0, width, height);

    ctx.save();

    const panelGradient = ctx.createLinearGradient(0, 0, width, height);
    panelGradient.addColorStop(0, "rgba(255, 255, 255, 0.02)");
    panelGradient.addColorStop(1, "rgba(255, 255, 255, 0.01)");

    ctx.fillStyle = panelGradient;
    roundRect(ctx, width * 0.02, height * 0.10, width * 0.96, height * 0.80, 16);
    ctx.fill();

    ctx.restore();
  }

  function drawWaterLine(y) {
    ctx.save();

    ctx.strokeStyle = "rgba(230, 245, 255, 0.20)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(modelXToScreenX(-trackLimit), y);
    ctx.lineTo(modelXToScreenX(trackLimit), y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(173, 216, 230, 0.11)";
    ctx.lineWidth = 1.0;

    const left = modelXToScreenX(-trackLimit);
    const right = modelXToScreenX(trackLimit);
    const span = right - left;

    ctx.beginPath();

    for (let i = 0; i <= 24; i += 1) {
      const t = i / 24;
      const x = left + span * t;
      const yy = y + Math.sin(t * Math.PI * 8 + performance.now() * 0.0022) * 1.6;

      if (i === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }

    ctx.stroke();

    ctx.restore();
  }

  function drawBoat(centerX, waterY, boatWidth, boatHeight) {
    const left = centerX - boatWidth / 2;
    const right = centerX + boatWidth / 2;
    const hullTop = waterY - boatHeight * 0.34;
    const hullBottom = waterY + boatHeight * 0.08;
    const bowX = right + boatWidth * 0.16;
    const sternX = left - boatWidth * 0.10;

    ctx.save();

    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.beginPath();
    ctx.ellipse(centerX, waterY + boatHeight * 0.42, boatWidth * 0.48, boatHeight * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();

    const hullGradient = ctx.createLinearGradient(left, hullTop, right, hullBottom);
    hullGradient.addColorStop(0, "rgba(250, 251, 253, 0.56)");
    hullGradient.addColorStop(1, "rgba(205, 219, 229, 0.46)");

    ctx.fillStyle = hullGradient;
    ctx.strokeStyle = "rgba(245, 250, 255, 0.58)";
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    ctx.moveTo(sternX + boatWidth * 0.12, hullTop);
    ctx.lineTo(right - boatWidth * 0.08, hullTop);
    ctx.quadraticCurveTo(bowX, hullTop + boatHeight * 0.10, right, hullBottom);
    ctx.lineTo(left + boatWidth * 0.18, hullBottom);
    ctx.quadraticCurveTo(sternX, hullBottom - boatHeight * 0.02, sternX + boatWidth * 0.12, hullTop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(120, 170, 190, 0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + boatWidth * 0.12, hullTop + boatHeight * 0.02);
    ctx.lineTo(right - boatWidth * 0.04, hullTop + boatHeight * 0.02);
    ctx.stroke();

    const cabinX = left + boatWidth * 0.24;
    const cabinY = hullTop - boatHeight * 0.36;
    const cabinW = boatWidth * 0.27;
    const cabinH = boatHeight * 0.28;

    ctx.fillStyle = "rgba(90, 106, 132, 0.34)";
    roundRect(ctx, cabinX, cabinY, cabinW, cabinH, 4);
    ctx.fill();

    ctx.fillStyle = "rgba(245, 250, 255, 0.42)";
    ctx.beginPath();
    ctx.moveTo(cabinX - boatWidth * 0.02, cabinY + 2);
    ctx.lineTo(cabinX + cabinW + boatWidth * 0.02, cabinY + 2);
    ctx.lineTo(cabinX + cabinW - boatWidth * 0.01, cabinY - boatHeight * 0.07);
    ctx.lineTo(cabinX + boatWidth * 0.04, cabinY - boatHeight * 0.07);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(240, 248, 255, 0.40)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + boatWidth * 0.08, hullTop - boatHeight * 0.08);
    ctx.lineTo(left + boatWidth * 0.08, hullTop - boatHeight * 0.30);
    ctx.stroke();

    ctx.fillStyle = "rgba(210, 236, 248, 0.42)";
    const windowY = cabinY + cabinH * 0.36;
    const w = boatWidth * 0.05;
    const h = boatHeight * 0.07;

    for (let i = 0; i < 3; i += 1) {
      roundRect(ctx, cabinX + boatWidth * (0.03 + i * 0.07), windowY, w, h, 2);
      ctx.fill();
    }

    ctx.fillStyle = "rgba(240, 248, 255, 0.48)";

    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.arc(left + boatWidth * (0.28 + i * 0.18), hullTop + boatHeight * 0.18, boatHeight * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(170, 225, 240, 0.38)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(right - boatWidth * 0.05, hullTop + boatHeight * 0.02);
    ctx.lineTo(bowX - boatWidth * 0.03, hullBottom - boatHeight * 0.01);
    ctx.stroke();

    ctx.strokeStyle = "rgba(190, 230, 240, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + boatWidth * 0.12, hullBottom + boatHeight * 0.10);
    ctx.quadraticCurveTo(centerX, hullBottom + boatHeight * 0.32, right - boatWidth * 0.06, hullBottom + boatHeight * 0.10);
    ctx.stroke();

    ctx.restore();
  }

  function drawDisturbanceArrow(boatCenterX, waterY, boatWidth, boatHeight, scale) {
    if (disturbanceFlash <= 0) return;

    const direction = disturbanceDirection || 1;
    const activeRatio =
      disturbanceDuration > 0
        ? clamp(disturbanceTimeLeft / disturbanceDuration, 0, 1)
        : 0;

    const forceRatio = clamp(Math.abs(disturbanceForce) / 145, 0.35, 1);
    const alpha =
      disturbanceTimeLeft > 0
        ? 0.62
        : Math.min(0.45, disturbanceFlash * 0.45);

    const arrowLength = clamp(scale * (0.18 + 0.09 * forceRatio), 24, 42);
    const gap = boatWidth * 0.15;

    const y = waterY - boatHeight * 0.95;

    const startX =
      direction > 0
        ? boatCenterX + boatWidth * 0.56 + gap
        : boatCenterX - boatWidth * 0.56 - gap;

    const endX = startX + direction * arrowLength;

    ctx.save();

    ctx.strokeStyle = `rgba(235, 248, 255, ${alpha})`;
    ctx.fillStyle = `rgba(235, 248, 255, ${alpha})`;
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
    ctx.stroke();

    const headSize = clamp(scale * 0.045, 5, 7);

    ctx.beginPath();
    ctx.moveTo(endX, y);
    ctx.lineTo(endX - direction * headSize, y - headSize * 0.55);
    ctx.lineTo(endX - direction * headSize, y + headSize * 0.55);
    ctx.closePath();
    ctx.fill();

    if (disturbanceTimeLeft > 0) {
      ctx.strokeStyle = `rgba(170, 222, 235, ${0.22 + 0.18 * activeRatio})`;
      ctx.lineWidth = 1.0;

      const pulseX =
        direction > 0
          ? boatCenterX + boatWidth * 0.5
          : boatCenterX - boatWidth * 0.5;

      ctx.beginPath();
      ctx.arc(
        pulseX,
        waterY - boatHeight * 0.25,
        8 + (1 - activeRatio) * 10,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawPendulum() {
    const scale = Math.min(width, height);
    const waterY = height * 0.76;

    const boatCenterX = modelXToScreenX(boatPosition);
    const boatWidth = clamp(scale * 0.44, 72, 118);
    const boatHeight = clamp(scale * 0.16, 18, 30);

    const pivotX = boatCenterX + boatWidth * 0.03;
    const pivotY = waterY - boatHeight * 0.68;

    const pendulumLength = clamp(scale * 0.32, 52, 84);

    const bobX = pivotX + pendulumLength * Math.sin(theta);
    const bobY = pivotY - pendulumLength * Math.cos(theta);

    bobTrail.push({ x: bobX, y: bobY });
    if (bobTrail.length > maxTrailLength) bobTrail.shift();

    ctx.save();

    drawWaterLine(waterY);
    drawBoat(boatCenterX, waterY, boatWidth, boatHeight);
    drawDisturbanceArrow(boatCenterX, waterY, boatWidth, boatHeight, scale);

    for (let i = 1; i < bobTrail.length; i += 1) {
      const previous = bobTrail[i - 1];
      const current = bobTrail[i];
      const age = i / bobTrail.length;

      ctx.strokeStyle = `rgba(182, 232, 242, ${0.012 + age * 0.15})`;
      ctx.lineWidth = 0.45 + age * 0.95;
      ctx.lineCap = "round";

      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(current.x, current.y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(238, 247, 252, 0.62)";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(bobX, bobY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(170, 222, 235, 0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(bobX, bobY);
    ctx.stroke();

    ctx.fillStyle = "rgba(245, 250, 255, 0.58)";
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, 3.6, 0, Math.PI * 2);
    ctx.fill();

    const bobGradient = ctx.createRadialGradient(
      bobX - 2,
      bobY - 2,
      1,
      bobX,
      bobY,
      10
    );

    bobGradient.addColorStop(0, "rgba(255, 255, 255, 0.72)");
    bobGradient.addColorStop(0.45, "rgba(216, 233, 239, 0.56)");
    bobGradient.addColorStop(1, "rgba(146, 182, 194, 0.36)");

    ctx.fillStyle = bobGradient;
    ctx.beginPath();
    ctx.arc(bobX, bobY, 8.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(240, 250, 255, 0.32)";
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.restore();
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);

    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function animate(now) {
    if (lastTime === null) lastTime = now;

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
})();