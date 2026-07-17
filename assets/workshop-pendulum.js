(function () {
  const canvas = document.getElementById("workshopPendulumCanvas");
  if (!canvas) return;

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (prefersReducedMotion) return;

  const ctx = canvas.getContext("2d");

  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastTime = null;
  let frameNumber = 0;

  const stateDimension = 6;

  /*
   * The track limit has been doubled from 6 to 12.
   * The physical boat range is now [-12, 12].
   */
  const trackLimit = 12;
  const desiredBoatPosition = 0;

  /*
   * State:
   * [x, xDot, theta1, thetaDot1, theta2, thetaDot2]
   *
   * Both angles are absolute angles measured from the upward vertical.
   */
  let boatPosition = randomBetween(
    -trackLimit * 0.15,
    trackLimit * 0.15
  );

  let boatVelocity = 0;

  let theta1 = Math.PI - 0.16;
  let thetaVelocity1 = 0;

  let theta2 = Math.PI + 0.13;
  let thetaVelocity2 = 0;

  const gravity = 9.81;

  const boatMass = 1.25;
  const firstMass = 0.19;
  const secondMass = 0.14;

  const firstLength = 0.72;
  const secondLength = 0.62;

  /*
   * Passive friction and water resistance.
   * These are not controlled torques.
   */
  const linearDrag = 0.23;
  const firstPivotDamping = 0.026;
  const secondPivotDamping = 0.022;
  const jointDamping = 0.012;

  /*
   * The only controller input is a horizontal force on the boat.
   */
  const maxControlForce = 82;
  const maxTotalForce = 125;

  let appliedControlForce = 0;
  let lastRequestedControl = 0;

  const horizonSteps = 27;
  const planningDt = 0.032;
  const ilqrIterations = 4;

  /*
   * Cost order:
   * [x, xDot, theta1, thetaDot1, theta2, thetaDot2]
   */
  const stageWeights = [
    0.1,
    0.09,
    13.5,
    0.82,
    10.5,
    0.66
  ];

  const terminalWeights = [
    0.75,
    0.3,
    62,
    5,
    48,
    4.1
  ];

  const controlWeight = 0.0021;

  let controlPlan = null;

  let disturbanceForce = 0;
  let disturbancePeakForce = 0;
  let disturbanceSourceSide = 1;
  let disturbanceElapsed = 0;
  let disturbanceTimeLeft = 0;
  let disturbanceDuration = 0;
  let disturbanceFlash = 0;

  const bobTrail = [];
  const maxTrailLength = 95;

  canvas.style.cursor = "pointer";
  canvas.title = "Click on either side to push the boat from that side";

  canvas.addEventListener("pointerdown", applyDisturbance);
  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();
  requestAnimationFrame(animate);

  function randomBetween(minimum, maximum) {
    return minimum + Math.random() * (maximum - minimum);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
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

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();

    width = rect.width || 560;
    height = rect.height || 150;
    dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function currentState() {
    return [
      boatPosition,
      boatVelocity,
      wrapAngle(theta1),
      thetaVelocity1,
      wrapAngle(theta2),
      thetaVelocity2
    ];
  }

  function setCurrentState(state) {
    boatPosition = state[0];
    boatVelocity = state[1];

    theta1 = wrapAngle(state[2]);
    thetaVelocity1 = state[3];

    theta2 = wrapAngle(state[4]);
    thetaVelocity2 = state[5];
  }

  function applyDisturbance(event) {
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const boatScreenX = modelXToScreenX(boatPosition);

    /*
     * +1 means the disturbance originates from the right.
     * -1 means it originates from the left.
     */
    disturbanceSourceSide = clickX >= boatScreenX ? 1 : -1;

    /*
     * A disturbance from the right pushes left.
     * A disturbance from the left pushes right.
     */
    const forceDirection = -disturbanceSourceSide;

    disturbancePeakForce =
      forceDirection * randomBetween(20, 32);

    disturbanceForce = 0;
    disturbanceDuration = randomBetween(0.17, 0.29);
    disturbanceElapsed = 0;
    disturbanceTimeLeft = disturbanceDuration;
    disturbanceFlash = 1;

    controlPlan = null;

    event.preventDefault();
  }

  function solveThreeByThree(matrix, vector) {
    const augmented = matrix.map((row, index) => [
      row[0],
      row[1],
      row[2],
      vector[index]
    ]);

    for (let column = 0; column < 3; column += 1) {
      let pivotRow = column;

      for (let row = column + 1; row < 3; row += 1) {
        if (
          Math.abs(augmented[row][column]) >
          Math.abs(augmented[pivotRow][column])
        ) {
          pivotRow = row;
        }
      }

      if (pivotRow !== column) {
        const temporaryRow = augmented[column];

        augmented[column] = augmented[pivotRow];
        augmented[pivotRow] = temporaryRow;
      }

      const pivot = augmented[column][column];

      if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-9) {
        return [0, 0, 0];
      }

      for (let item = column; item < 4; item += 1) {
        augmented[column][item] /= pivot;
      }

      for (let row = 0; row < 3; row += 1) {
        if (row === column) continue;

        const factor = augmented[row][column];

        for (let item = column; item < 4; item += 1) {
          augmented[row][item] -=
            factor * augmented[column][item];
        }
      }
    }

    return [
      augmented[0][3],
      augmented[1][3],
      augmented[2][3]
    ];
  }

  /*
   * Nonlinear cart-double-pendulum dynamics.
   *
   * Generalized coordinates:
   *
   * q = [x, theta1, theta2]
   *
   * Controlled generalized force:
   *
   * Q = [F, 0, 0]
   *
   * Therefore, the controller acts only on the boat.
   */
  function doublePendulumNext(
    state,
    forceInput,
    dt,
    enforceRail
  ) {
    let x = state[0];
    let xDot = state[1];

    let angle1 = wrapAngle(state[2]);
    let angleDot1 = state[3];

    let angle2 = wrapAngle(state[4]);
    let angleDot2 = state[5];

    const commandedForce = clamp(
      forceInput,
      -maxTotalForce,
      maxTotalForce
    );

    /*
     * Passive water resistance on the boat.
     */
    const force =
      commandedForce - linearDrag * xDot;

    const combinedMass = firstMass + secondMass;
    const angleDifference = angle1 - angle2;

    const massMatrix = [
      [
        boatMass + firstMass + secondMass,
        combinedMass * firstLength * Math.cos(angle1),
        secondMass * secondLength * Math.cos(angle2)
      ],
      [
        combinedMass * firstLength * Math.cos(angle1),
        combinedMass * firstLength * firstLength,
        secondMass *
          firstLength *
          secondLength *
          Math.cos(angleDifference)
      ],
      [
        secondMass * secondLength * Math.cos(angle2),
        secondMass *
          firstLength *
          secondLength *
          Math.cos(angleDifference),
        secondMass * secondLength * secondLength
      ]
    ];

    const relativeAngularVelocity =
      angleDot2 - angleDot1;

    const jointFriction =
      jointDamping * relativeAngularVelocity;

    /*
     * The controlled force appears only in the first component.
     * The angular components contain gravity, coupling, and
     * passive damping only.
     */
    const generalizedForces = [
      force +
        combinedMass *
          firstLength *
          Math.sin(angle1) *
          angleDot1 *
          angleDot1 +
        secondMass *
          secondLength *
          Math.sin(angle2) *
          angleDot2 *
          angleDot2,

      -combinedMass *
        gravity *
        firstLength *
        Math.sin(angle1) -
        secondMass *
          firstLength *
          secondLength *
          Math.sin(angleDifference) *
          angleDot2 *
          angleDot2 -
        firstPivotDamping * angleDot1 +
        jointFriction,

      -secondMass *
        gravity *
        secondLength *
        Math.sin(angle2) +
        secondMass *
          firstLength *
          secondLength *
          Math.sin(angleDifference) *
          angleDot1 *
          angleDot1 -
        secondPivotDamping * angleDot2 -
        jointFriction
    ];

    const acceleration = solveThreeByThree(
      massMatrix,
      generalizedForces
    );

    xDot += acceleration[0] * dt;
    angleDot1 += acceleration[1] * dt;
    angleDot2 += acceleration[2] * dt;

    x += xDot * dt;

    angle1 = wrapAngle(
      angle1 + angleDot1 * dt
    );

    angle2 = wrapAngle(
      angle2 + angleDot2 * dt
    );

    /*
     * The animation uses the doubled trackLimit here.
     */
    if (enforceRail) {
      if (x > trackLimit) {
        x = trackLimit;
        xDot = Math.min(0, xDot) * 0.22;
      }

      if (x < -trackLimit) {
        x = -trackLimit;
        xDot = Math.max(0, xDot) * 0.22;
      }
    }

    return [
      x,
      xDot,
      angle1,
      angleDot1,
      angle2,
      angleDot2
    ];
  }

  function stateDifference(firstState, secondState) {
    return [
      firstState[0] - secondState[0],
      firstState[1] - secondState[1],
      wrapAngle(firstState[2] - secondState[2]),
      firstState[3] - secondState[3],
      wrapAngle(firstState[4] - secondState[4]),
      firstState[5] - secondState[5]
    ];
  }

  function addToState(state, index, amount) {
    const result = state.slice();

    result[index] += amount;

    if (index === 2 || index === 4) {
      result[index] = wrapAngle(result[index]);
    }

    return result;
  }

  function dot(firstVector, secondVector) {
    let value = 0;

    for (
      let index = 0;
      index < firstVector.length;
      index += 1
    ) {
      value += firstVector[index] * secondVector[index];
    }

    return value;
  }

  /*
   * The controller barrier uses the same doubled trackLimit.
   * It begins becoming strong at approximately 96% of the track.
   */
  function barrierDerivatives(position, weight) {
    const effectiveLimit = trackLimit * 0.96;
    const epsilon = 0.06;

    const rightDistance = Math.max(
      epsilon,
      effectiveLimit - position
    );

    const leftDistance = Math.max(
      epsilon,
      effectiveLimit + position
    );

    let cost =
      -weight *
      (
        Math.log(rightDistance / effectiveLimit) +
        Math.log(leftDistance / effectiveLimit)
      );

    let gradient =
      weight *
      (
        1 / rightDistance -
        1 / leftDistance
      );

    let hessian =
      weight *
      (
        1 / (rightDistance * rightDistance) +
        1 / (leftDistance * leftDistance)
      );

    const violation = Math.max(
      0,
      Math.abs(position) - effectiveLimit
    );

    if (violation > 0) {
      cost += 650 * violation * violation;

      gradient +=
        Math.sign(position) * 1300 * violation;

      hessian += 1300;
    }

    return {
      cost,
      gradient,
      hessian
    };
  }

  function costDerivatives(state, control, terminal) {
    const weights = terminal
      ? terminalWeights
      : stageWeights;

    const error = [
      state[0] - desiredBoatPosition,
      state[1],
      wrapAngle(state[2]),
      state[3],
      wrapAngle(state[4]),
      state[5]
    ];

    const barrier = barrierDerivatives(
      state[0],
      terminal ? 0.7 : 0.12
    );

    const lx = error.map(
      (value, index) =>
        2 * weights[index] * value
    );

    const lxx = Array.from(
      { length: stateDimension },
      (_, row) =>
        Array.from(
          { length: stateDimension },
          (_, column) =>
            row === column
              ? 2 * weights[row]
              : 0
        )
    );

    lx[0] += barrier.gradient;
    lxx[0][0] += barrier.hessian;

    return {
      lx,
      lxx,

      lu: terminal
        ? 0
        : 2 * controlWeight * control,

      luu: terminal
        ? 0
        : 2 * controlWeight
    };
  }

  function stageCost(state, control, terminal) {
    const weights = terminal
      ? terminalWeights
      : stageWeights;

    const error = [
      state[0] - desiredBoatPosition,
      state[1],
      wrapAngle(state[2]),
      state[3],
      wrapAngle(state[4]),
      state[5]
    ];

    let cost = error.reduce(
      (sum, value, index) =>
        sum + weights[index] * value * value,
      0
    );

    cost += barrierDerivatives(
      state[0],
      terminal ? 0.7 : 0.12
    ).cost;

    if (!terminal) {
      cost += controlWeight * control * control;
    }

    return cost;
  }

  function rollout(initialState, controls) {
    const states = [initialState.slice()];

    for (const control of controls) {
      states.push(
        doublePendulumNext(
          states[states.length - 1],
          control,
          planningDt,
          false
        )
      );
    }

    return states;
  }

  function trajectoryCost(states, controls) {
    let totalCost = 0;

    for (
      let step = 0;
      step < controls.length;
      step += 1
    ) {
      totalCost += stageCost(
        states[step],
        controls[step],
        false
      );
    }

    totalCost += stageCost(
      states[states.length - 1],
      0,
      true
    );

    return totalCost;
  }

  function linearizeDynamics(state, control) {
    const stateEpsilon = [
      0.003,
      0.004,
      0.002,
      0.004,
      0.002,
      0.004
    ];

    const controlEpsilon = 0.09;

    const A = Array.from(
      { length: stateDimension },
      () => new Array(stateDimension).fill(0)
    );

    for (
      let column = 0;
      column < stateDimension;
      column += 1
    ) {
      const plusState = addToState(
        state,
        column,
        stateEpsilon[column]
      );

      const minusState = addToState(
        state,
        column,
        -stateEpsilon[column]
      );

      const plusResult = doublePendulumNext(
        plusState,
        control,
        planningDt,
        false
      );

      const minusResult = doublePendulumNext(
        minusState,
        control,
        planningDt,
        false
      );

      const difference = stateDifference(
        plusResult,
        minusResult
      );

      for (
        let row = 0;
        row < stateDimension;
        row += 1
      ) {
        A[row][column] =
          difference[row] /
          (2 * stateEpsilon[column]);
      }
    }

    const plusControlResult = doublePendulumNext(
      state,
      control + controlEpsilon,
      planningDt,
      false
    );

    const minusControlResult = doublePendulumNext(
      state,
      control - controlEpsilon,
      planningDt,
      false
    );

    const controlDifference = stateDifference(
      plusControlResult,
      minusControlResult
    );

    const B = controlDifference.map(
      (value) =>
        value / (2 * controlEpsilon)
    );

    return {
      A,
      B
    };
  }

  function transposeTimesVector(matrix, vector) {
    const result =
      new Array(matrix[0].length).fill(0);

    for (
      let row = 0;
      row < matrix.length;
      row += 1
    ) {
      for (
        let column = 0;
        column < matrix[row].length;
        column += 1
      ) {
        result[column] +=
          matrix[row][column] * vector[row];
      }
    }

    return result;
  }

  function matrixTimesVector(matrix, vector) {
    return matrix.map(
      (row) => dot(row, vector)
    );
  }

  function atMa(A, M) {
    const result = Array.from(
      { length: stateDimension },
      () => new Array(stateDimension).fill(0)
    );

    for (
      let i = 0;
      i < stateDimension;
      i += 1
    ) {
      for (
        let j = 0;
        j < stateDimension;
        j += 1
      ) {
        for (
          let p = 0;
          p < stateDimension;
          p += 1
        ) {
          for (
            let q = 0;
            q < stateDimension;
            q += 1
          ) {
            result[i][j] +=
              A[p][i] *
              M[p][q] *
              A[q][j];
          }
        }
      }
    }

    return result;
  }

  function bTMa(B, M, A) {
    const result =
      new Array(stateDimension).fill(0);

    for (
      let column = 0;
      column < stateDimension;
      column += 1
    ) {
      for (
        let p = 0;
        p < stateDimension;
        p += 1
      ) {
        for (
          let q = 0;
          q < stateDimension;
          q += 1
        ) {
          result[column] +=
            B[p] *
            M[p][q] *
            A[q][column];
        }
      }
    }

    return result;
  }

  function symmetrize(matrix) {
    for (
      let row = 0;
      row < stateDimension;
      row += 1
    ) {
      matrix[row][row] += 1e-7;

      for (
        let column = row + 1;
        column < stateDimension;
        column += 1
      ) {
        const average =
          0.5 *
          (
            matrix[row][column] +
            matrix[column][row]
          );

        matrix[row][column] = average;
        matrix[column][row] = average;
      }
    }

    return matrix;
  }

  function energySwingSeed(state, step) {
    const angle1 = wrapAngle(state[2]);
    const angularVelocity1 = state[3];

    const angle2 = wrapAngle(state[4]);
    const angularVelocity2 = state[5];

    const firstEnergy =
      0.5 *
        Math.pow(
          firstLength * angularVelocity1,
          2
        ) +
      gravity *
        firstLength *
        (Math.cos(angle1) - 1);

    const secondEnergy =
      0.5 *
        Math.pow(
          secondLength * angularVelocity2,
          2
        ) +
      gravity *
        secondLength *
        (Math.cos(angle2) - 1);

    const pumping =
      11.5 *
        angularVelocity1 *
        Math.cos(angle1) *
        firstEnergy +
      7.5 *
        angularVelocity2 *
        Math.cos(angle2) *
        secondEnergy;

    const probing =
      14 *
        Math.sin(
          performance.now() * 0.0021 +
          step * 0.42
        ) +
      5 *
        Math.sin(
          performance.now() * 0.0013 +
          step * 0.19
        );

    const centering =
      -1.25 *
        (state[0] - desiredBoatPosition) -
      0.9 * state[1];

    return clamp(
      pumping + probing + centering,
      -maxControlForce,
      maxControlForce
    );
  }

  function initialControlSequence(state) {
    const controls = [];
    let simulatedState = state.slice();

    for (
      let step = 0;
      step < horizonSteps;
      step += 1
    ) {
      const control = energySwingSeed(
        simulatedState,
        step
      );

      controls.push(control);

      simulatedState = doublePendulumNext(
        simulatedState,
        control,
        planningDt,
        false
      );
    }

    return controls;
  }

  function optimizeWithILQR(
    initialState,
    initialControls
  ) {
    let controls = initialControls.slice();
    let states = rollout(initialState, controls);
    let bestCost = trajectoryCost(states, controls);

    for (
      let iteration = 0;
      iteration < ilqrIterations;
      iteration += 1
    ) {
      const feedforward =
        new Array(horizonSteps);

      const feedback =
        new Array(horizonSteps);

      const terminal = costDerivatives(
        states[states.length - 1],
        0,
        true
      );

      let valueGradient = terminal.lx.slice();

      let valueHessian =
        terminal.lxx.map(
          (row) => row.slice()
        );

      let failed = false;

      for (
        let step = horizonSteps - 1;
        step >= 0;
        step -= 1
      ) {
        const state = states[step];
        const control = controls[step];

        const linearization =
          linearizeDynamics(state, control);

        const A = linearization.A;
        const B = linearization.B;

        const derivatives = costDerivatives(
          state,
          control,
          false
        );

        const futureGradient =
          transposeTimesVector(
            A,
            valueGradient
          );

        const Qx = derivatives.lx.map(
          (value, index) =>
            value + futureGradient[index]
        );

        const Qu =
          derivatives.lu +
          dot(B, valueGradient);

        const hessianTimesB =
          matrixTimesVector(
            valueHessian,
            B
          );

        const Quu =
          derivatives.luu +
          dot(B, hessianTimesB) +
          0.0008;

        if (
          !Number.isFinite(Quu) ||
          Quu <= 1e-8
        ) {
          failed = true;
          break;
        }

        const futureQxx = atMa(
          A,
          valueHessian
        );

        const Qxx = derivatives.lxx.map(
          (row, rowIndex) =>
            row.map(
              (value, columnIndex) =>
                value +
                futureQxx[rowIndex][columnIndex]
            )
        );

        const Qux = bTMa(
          B,
          valueHessian,
          A
        );

        const feedforwardControl =
          -Qu / Quu;

        const feedbackControl =
          Qux.map(
            (value) => -value / Quu
          );

        feedforward[step] =
          feedforwardControl;

        feedback[step] =
          feedbackControl;

        const nextGradient =
          new Array(stateDimension).fill(0);

        const nextHessian = Array.from(
          { length: stateDimension },
          () =>
            new Array(stateDimension).fill(0)
        );

        for (
          let i = 0;
          i < stateDimension;
          i += 1
        ) {
          nextGradient[i] =
            Qx[i] +
            feedbackControl[i] *
              Quu *
              feedforwardControl +
            feedbackControl[i] * Qu +
            Qux[i] * feedforwardControl;

          for (
            let j = 0;
            j < stateDimension;
            j += 1
          ) {
            nextHessian[i][j] =
              Qxx[i][j] +
              feedbackControl[i] *
                Quu *
                feedbackControl[j] +
              feedbackControl[i] * Qux[j] +
              Qux[i] * feedbackControl[j];
          }
        }

        valueGradient = nextGradient;
        valueHessian =
          symmetrize(nextHessian);
      }

      if (failed) break;

      let accepted = false;

      const lineSearchValues = [
        1,
        0.55,
        0.25,
        0.1
      ];

      for (const alpha of lineSearchValues) {
        const candidateControls = [];

        const candidateStates = [
          initialState.slice()
        ];

        for (
          let step = 0;
          step < horizonSteps;
          step += 1
        ) {
          const difference = stateDifference(
            candidateStates[step],
            states[step]
          );

          const correction =
            alpha * feedforward[step] +
            dot(
              feedback[step],
              difference
            );

          const candidateControl = clamp(
            controls[step] + correction,
            -maxControlForce,
            maxControlForce
          );

          candidateControls.push(
            candidateControl
          );

          candidateStates.push(
            doublePendulumNext(
              candidateStates[step],
              candidateControl,
              planningDt,
              false
            )
          );
        }

        const candidateCost =
          trajectoryCost(
            candidateStates,
            candidateControls
          );

        if (
          Number.isFinite(candidateCost) &&
          candidateCost < bestCost
        ) {
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

  function computeControl() {
    const state = currentState();

    let controls;

    if (
      !controlPlan ||
      controlPlan.length !== horizonSteps
    ) {
      controls =
        initialControlSequence(state);
    } else {
      controls = controlPlan.slice();

      const firstAngle =
        Math.abs(wrapAngle(state[2]));

      const secondAngle =
        Math.abs(wrapAngle(state[4]));

      if (
        firstAngle > 0.75 ||
        secondAngle > 0.75
      ) {
        const seed =
          initialControlSequence(state);

        for (
          let step = 0;
          step < horizonSteps;
          step += 1
        ) {
          controls[step] =
            0.68 * controls[step] +
            0.32 * seed[step];
        }
      }
    }

    const optimizedControls =
      optimizeWithILQR(
        state,
        controls
      );

    const firstControl =
      optimizedControls[0];

    controlPlan =
      optimizedControls.slice(1);

    controlPlan.push(
      optimizedControls[
        optimizedControls.length - 1
      ]
    );

    return clamp(
      firstControl,
      -maxControlForce,
      maxControlForce
    );
  }

  function stepDynamics(dt, controlForce) {
    let externalForce = 0;

    if (disturbanceTimeLeft > 0) {
      disturbanceElapsed = Math.min(
        disturbanceDuration,
        disturbanceElapsed + dt
      );

      const progress =
        disturbanceElapsed /
        disturbanceDuration;

      /*
       * Smooth, physically plausible half-sine force pulse.
       */
      const envelope =
        Math.sin(Math.PI * progress);

      disturbanceForce =
        disturbancePeakForce * envelope;

      externalForce = disturbanceForce;

      disturbanceTimeLeft = Math.max(
        0,
        disturbanceDuration -
          disturbanceElapsed
      );

      disturbanceFlash = 1;
    } else {
      disturbanceForce = 0;
      disturbancePeakForce = 0;

      disturbanceFlash = Math.max(
        0,
        disturbanceFlash - dt * 2.1
      );
    }

    /*
     * Both the controller and disturbance enter through the
     * same horizontal boat-force channel.
     */
    const totalForce = clamp(
      controlForce + externalForce,
      -maxTotalForce,
      maxTotalForce
    );

    const nextState =
      doublePendulumNext(
        currentState(),
        totalForce,
        dt,
        true
      );

    setCurrentState(nextState);
  }

  /*
   * Maps the complete physical interval [-12, 12] onto the canvas.
   */
  function modelXToScreenX(position) {
    const halfRange = width * 0.48;

    return (
      width * 0.5 +
      (position / trackLimit) * halfRange
    );
  }

  function roundRect(
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

  function drawBackground() {
    ctx.clearRect(
      0,
      0,
      width,
      height
    );

    const gradient =
      ctx.createLinearGradient(
        0,
        0,
        width,
        height
      );

    gradient.addColorStop(
      0,
      "rgba(255, 255, 255, 0.025)"
    );

    gradient.addColorStop(
      1,
      "rgba(255, 255, 255, 0.008)"
    );

    ctx.fillStyle = gradient;

    roundRect(
      ctx,
      width * 0.02,
      height * 0.1,
      width * 0.96,
      height * 0.8,
      16
    );

    ctx.fill();
  }

  function drawWaterLine(y) {
    const left =
      modelXToScreenX(-trackLimit);

    const right =
      modelXToScreenX(trackLimit);

    ctx.save();

    ctx.strokeStyle =
      "rgba(230, 245, 255, 0.20)";

    ctx.lineWidth = 1.4;
    ctx.beginPath();

    for (
      let index = 0;
      index <= 32;
      index += 1
    ) {
      const ratio = index / 32;

      const x =
        left +
        (right - left) * ratio;

      const wave =
        Math.sin(
          ratio * Math.PI * 10 +
          performance.now() * 0.002
        ) * 1.5;

      if (index === 0) {
        ctx.moveTo(x, y + wave);
      } else {
        ctx.lineTo(x, y + wave);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  function drawBoat(
    centerX,
    waterY,
    boatWidth,
    boatHeight
  ) {
    const left =
      centerX - boatWidth / 2;

    const right =
      centerX + boatWidth / 2;

    const hullTop =
      waterY - boatHeight * 0.34;

    const hullBottom =
      waterY + boatHeight * 0.1;

    ctx.save();

    ctx.fillStyle =
      "rgba(0, 0, 0, 0.13)";

    ctx.beginPath();

    ctx.ellipse(
      centerX,
      waterY + boatHeight * 0.42,
      boatWidth * 0.48,
      boatHeight * 0.2,
      0,
      0,
      Math.PI * 2
    );

    ctx.fill();

    const hullGradient =
      ctx.createLinearGradient(
        left,
        hullTop,
        right,
        hullBottom
      );

    hullGradient.addColorStop(
      0,
      "rgba(250, 251, 253, 0.58)"
    );

    hullGradient.addColorStop(
      1,
      "rgba(205, 219, 229, 0.46)"
    );

    ctx.fillStyle = hullGradient;

    ctx.strokeStyle =
      "rgba(245, 250, 255, 0.58)";

    ctx.lineWidth = 1.2;
    ctx.beginPath();

    ctx.moveTo(
      left - boatWidth * 0.08,
      hullTop
    );

    ctx.lineTo(
      right - boatWidth * 0.08,
      hullTop
    );

    ctx.quadraticCurveTo(
      right + boatWidth * 0.15,
      hullTop + boatHeight * 0.12,
      right,
      hullBottom
    );

    ctx.lineTo(
      left + boatWidth * 0.16,
      hullBottom
    );

    ctx.quadraticCurveTo(
      left - boatWidth * 0.12,
      hullBottom,
      left - boatWidth * 0.08,
      hullTop
    );

    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const cabinWidth =
      boatWidth * 0.28;

    const cabinHeight =
      boatHeight * 0.27;

    ctx.fillStyle =
      "rgba(95, 112, 137, 0.36)";

    roundRect(
      ctx,
      left + boatWidth * 0.25,
      hullTop - cabinHeight,
      cabinWidth,
      cabinHeight,
      4
    );

    ctx.fill();
    ctx.restore();
  }

  function drawDisturbanceArrow(
    boatCenterX,
    waterY,
    boatWidth,
    boatHeight,
    scale
  ) {
    if (disturbanceFlash <= 0) return;

    const sourceSide =
      disturbanceSourceSide || 1;

    const forceDirection =
      -sourceSide;

    const forceRatio = clamp(
      Math.abs(disturbancePeakForce) / 32,
      0.35,
      1
    );

    const arrowLength = clamp(
      scale *
        (0.18 + 0.08 * forceRatio),
      24,
      42
    );

    const contactX =
      boatCenterX +
      sourceSide * boatWidth * 0.56;

    const startX =
      contactX +
      sourceSide *
        (
          arrowLength +
          boatWidth * 0.12
        );

    const endX = contactX;

    const y =
      waterY - boatHeight * 0.9;

    const alpha =
      disturbanceTimeLeft > 0
        ? 0.66
        : disturbanceFlash * 0.42;

    const headSize = clamp(
      scale * 0.045,
      5,
      7
    );

    ctx.save();

    ctx.strokeStyle =
      `rgba(235, 248, 255, ${alpha})`;

    ctx.fillStyle =
      `rgba(235, 248, 255, ${alpha})`;

    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(endX, y);

    ctx.lineTo(
      endX -
        forceDirection * headSize,
      y - headSize * 0.55
    );

    ctx.lineTo(
      endX -
        forceDirection * headSize,
      y + headSize * 0.55
    );

    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawRod(
    startX,
    startY,
    endX,
    endY,
    alpha
  ) {
    ctx.strokeStyle =
      `rgba(238, 247, 252, ${alpha})`;

    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }

  function drawJoint(
    x,
    y,
    radius,
    brightness
  ) {
    const gradient =
      ctx.createRadialGradient(
        x - radius * 0.25,
        y - radius * 0.25,
        1,
        x,
        y,
        radius
      );

    gradient.addColorStop(
      0,
      `rgba(255, 255, 255, ${brightness})`
    );

    gradient.addColorStop(
      0.5,
      "rgba(216, 233, 239, 0.58)"
    );

    gradient.addColorStop(
      1,
      "rgba(146, 182, 194, 0.38)"
    );

    ctx.fillStyle = gradient;

    ctx.beginPath();

    ctx.arc(
      x,
      y,
      radius,
      0,
      Math.PI * 2
    );

    ctx.fill();
  }

  function drawDoublePendulum() {
    const scale =
      Math.min(width, height);

    const waterY =
      height * 0.78;

    const boatCenterX =
      modelXToScreenX(boatPosition);

    const boatWidth = clamp(
      scale * 0.42,
      72,
      116
    );

    const boatHeight = clamp(
      scale * 0.15,
      18,
      29
    );

    const pivotX =
      boatCenterX +
      boatWidth * 0.03;

    const pivotY =
      waterY -
      boatHeight * 0.68;

    const firstDrawLength = clamp(
      scale * 0.235,
      37,
      62
    );

    const secondDrawLength = clamp(
      scale * 0.205,
      33,
      55
    );

    const firstJointX =
      pivotX +
      firstDrawLength *
        Math.sin(theta1);

    const firstJointY =
      pivotY -
      firstDrawLength *
        Math.cos(theta1);

    const secondBobX =
      firstJointX +
      secondDrawLength *
        Math.sin(theta2);

    const secondBobY =
      firstJointY -
      secondDrawLength *
        Math.cos(theta2);

    bobTrail.push({
      x: secondBobX,
      y: secondBobY
    });

    if (
      bobTrail.length >
      maxTrailLength
    ) {
      bobTrail.shift();
    }

    ctx.save();

    drawWaterLine(waterY);

    drawBoat(
      boatCenterX,
      waterY,
      boatWidth,
      boatHeight
    );

    drawDisturbanceArrow(
      boatCenterX,
      waterY,
      boatWidth,
      boatHeight,
      scale
    );

    for (
      let index = 1;
      index < bobTrail.length;
      index += 1
    ) {
      const previous =
        bobTrail[index - 1];

      const current =
        bobTrail[index];

      const age =
        index / bobTrail.length;

      ctx.strokeStyle =
        `rgba(182, 232, 242, ${0.01 + age * 0.16})`;

      ctx.lineWidth =
        0.45 + age;

      ctx.beginPath();

      ctx.moveTo(
        previous.x,
        previous.y
      );

      ctx.lineTo(
        current.x,
        current.y
      );

      ctx.stroke();
    }

    drawRod(
      pivotX,
      pivotY,
      firstJointX,
      firstJointY,
      0.66
    );

    drawRod(
      firstJointX,
      firstJointY,
      secondBobX,
      secondBobY,
      0.58
    );

    drawJoint(
      pivotX,
      pivotY,
      3.5,
      0.68
    );

    drawJoint(
      firstJointX,
      firstJointY,
      6.2,
      0.74
    );

    drawJoint(
      secondBobX,
      secondBobY,
      8.2,
      0.8
    );

    ctx.restore();
  }

  function animate(now) {
    if (lastTime === null) {
      lastTime = now;
    }

    const dt = Math.min(
      0.024,
      Math.max(
        0.001,
        (now - lastTime) / 1000
      )
    );

    lastTime = now;

    /*
     * Replan every second frame.
     */
    if (
      frameNumber % 2 === 0 ||
      !controlPlan
    ) {
      lastRequestedControl =
        computeControl();
    }

    frameNumber += 1;

    /*
     * Smooth actuator response.
     */
    const actuatorTimeConstant = 0.09;

    const controlBlend =
      1 -
      Math.exp(
        -dt / actuatorTimeConstant
      );

    appliedControlForce +=
      (
        lastRequestedControl -
        appliedControlForce
      ) *
      controlBlend;

    const substeps = 4;
    const substepDt = dt / substeps;

    for (
      let step = 0;
      step < substeps;
      step += 1
    ) {
      stepDynamics(
        substepDt,
        appliedControlForce
      );
    }

    drawBackground();
    drawDoublePendulum();

    requestAnimationFrame(animate);
  }
})();