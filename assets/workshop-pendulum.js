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

  /*
   * State:
   *
   * [x, xDot, theta1, theta1Dot, theta2, theta2Dot]
   *
   * theta1 and theta2 are absolute angles measured
   * from the upward vertical:
   *
   * theta = 0       -> upright
   * theta = +/- pi  -> hanging downward
   */
  const stateDimension = 6;

  const trackLimit = 12;
  const desiredBoatPosition = 0;

  /*
   * Begin close to the unstable upright configuration.
   *
   * The controller must actively stabilize both links.
   */
  let boatPosition = randomBetween(-0.6, 0.6);
  let boatVelocity = 0;

  let theta1 = randomBetween(-0.14, 0.14);
  let thetaVelocity1 = 0;

  let theta2 = randomBetween(-0.11, 0.11);
  let thetaVelocity2 = 0;

  /*
   * Physical parameters.
   *
   * Boat + serial double pendulum.
   */
  const gravity = 9.81;

  const boatMass = 1.15;

  const firstMass = 0.20;
  const secondMass = 0.14;

  const firstLength = 0.82;
  const secondLength = 0.68;

  /*
   * Passive dissipation.
   *
   * There are no controlled torques at either pendulum joint.
   *
   * The only controller input is a horizontal force on the boat.
   */
  const linearDrag = 0.14;

  const firstPivotDamping = 0.018;
  const secondPivotDamping = 0.014;

  const jointDamping = 0.008;

  /*
   * Force limits.
   */
  const maxControlForce = 115;
  const maxTotalForce = 165;

  /*
   * iLQR settings.
   */
  const horizonSteps = 28;
  const planningDt = 0.035;
  const ilqrIterations = 4;

  /*
   * State cost order:
   *
   * [
   *   x,
   *   xDot,
   *   theta1,
   *   theta1Dot,
   *   theta2,
   *   theta2Dot
   * ]
   */
  const stageWeights = [
    0.34,
    0.12,
    22.0,
    0.95,
    17.0,
    0.75
  ];

  const terminalWeights = [
    4.8,
    0.9,
    110.0,
    7.0,
    86.0,
    5.5
  ];

  const controlWeight = 0.00115;

  let controlPlan = null;
  let requestedControl = 0;

  /*
   * User disturbance.
   *
   * Clicking applies a smooth horizontal force pulse
   * to the boat only.
   */
  let disturbanceSourceSide = 1;

  let disturbancePeakForce = 0;
  let disturbanceElapsed = 0;
  let disturbanceDuration = 0;

  let disturbanceFlash = 0;

  /*
   * Trail of the second pendulum mass.
   */
  const bobTrail = [];
  const maxTrailLength = 90;

  canvas.style.cursor = "pointer";
  canvas.title = "Click on either side to push the boat";

  canvas.addEventListener(
    "pointerdown",
    applyDisturbance
  );

  window.addEventListener(
    "resize",
    resizeCanvas
  );

  resizeCanvas();
  requestAnimationFrame(animate);

  /*
   * ------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------
   */

  function randomBetween(minimum, maximum) {
    return minimum + Math.random() * (maximum - minimum);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(
      minimum,
      Math.min(maximum, value)
    );
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

  /*
   * ------------------------------------------------------------
   * Canvas
   * ------------------------------------------------------------
   */

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();

    width = rect.width || 560;
    height = rect.height || 150;

    dpr = Math.max(
      1,
      window.devicePixelRatio || 1
    );

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.setTransform(
      dpr,
      0,
      0,
      dpr,
      0,
      0
    );
  }

  /*
   * ------------------------------------------------------------
   * State
   * ------------------------------------------------------------
   */

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

  /*
   * ------------------------------------------------------------
   * User disturbance
   * ------------------------------------------------------------
   */

  function applyDisturbance(event) {
    const rect = canvas.getBoundingClientRect();

    const clickX =
      event.clientX - rect.left;

    const boatScreenX =
      modelXToScreenX(boatPosition);

    /*
     * +1 -> disturbance comes from the right.
     * -1 -> disturbance comes from the left.
     */
    disturbanceSourceSide =
      clickX >= boatScreenX
        ? 1
        : -1;

    /*
     * A push from the right acts to the left.
     * A push from the left acts to the right.
     */
    disturbancePeakForce =
      -disturbanceSourceSide *
      randomBetween(42, 62);

    disturbanceDuration =
      randomBetween(0.18, 0.30);

    disturbanceElapsed = 0;
    disturbanceFlash = 1;

    /*
     * Force iLQR to rebuild its trajectory
     * following the unexpected disturbance.
     */
    controlPlan = null;

    event.preventDefault();
  }

  /*
   * ------------------------------------------------------------
   * Linear algebra
   * ------------------------------------------------------------
   */

  function solveThreeByThree(matrix, vector) {
    const augmented = matrix.map(
      (row, index) => [
        row[0],
        row[1],
        row[2],
        vector[index]
      ]
    );

    for (
      let column = 0;
      column < 3;
      column += 1
    ) {
      let pivotRow = column;

      for (
        let row = column + 1;
        row < 3;
        row += 1
      ) {
        if (
          Math.abs(augmented[row][column]) >
          Math.abs(augmented[pivotRow][column])
        ) {
          pivotRow = row;
        }
      }

      if (pivotRow !== column) {
        const temporaryRow = augmented[column];

        augmented[column] =
          augmented[pivotRow];

        augmented[pivotRow] =
          temporaryRow;
      }

      const pivot =
        augmented[column][column];

      if (
        !Number.isFinite(pivot) ||
        Math.abs(pivot) < 1e-10
      ) {
        return [0, 0, 0];
      }

      for (
        let item = column;
        item < 4;
        item += 1
      ) {
        augmented[column][item] /= pivot;
      }

      for (
        let row = 0;
        row < 3;
        row += 1
      ) {
        if (row === column) continue;

        const factor =
          augmented[row][column];

        for (
          let item = column;
          item < 4;
          item += 1
        ) {
          augmented[row][item] -=
            factor *
            augmented[column][item];
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
   * ------------------------------------------------------------
   * Nonlinear double inverted pendulum dynamics
   * ------------------------------------------------------------
   *
   * Generalized coordinates:
   *
   * q = [x, theta1, theta2]
   *
   * theta1 and theta2 are absolute angles measured
   * from the upward vertical.
   *
   * Only x is actuated.
   *
   * Q = [F, 0, 0]
   * ------------------------------------------------------------
   */

  function stateDerivative(
    state,
    controlForce
  ) {
    const velocity = state[1];

    const angle1 =
      wrapAngle(state[2]);

    const angularVelocity1 =
      state[3];

    const angle2 =
      wrapAngle(state[4]);

    const angularVelocity2 =
      state[5];

    /*
     * Horizontal force with passive water drag.
     */
    const force =
      clamp(
        controlForce,
        -maxTotalForce,
        maxTotalForce
      ) -
      linearDrag * velocity;

    const combinedMass =
      firstMass + secondMass;

    const angleDifference =
      angle1 - angle2;

    const sin1 =
      Math.sin(angle1);

    const cos1 =
      Math.cos(angle1);

    const sin2 =
      Math.sin(angle2);

    const cos2 =
      Math.cos(angle2);

    const sinDifference =
      Math.sin(angleDifference);

    const cosDifference =
      Math.cos(angleDifference);

    /*
     * Mass matrix M(q).
     */
    const massMatrix = [
      [
        boatMass +
          firstMass +
          secondMass,

        combinedMass *
          firstLength *
          cos1,

        secondMass *
          secondLength *
          cos2
      ],

      [
        combinedMass *
          firstLength *
          cos1,

        combinedMass *
          firstLength *
          firstLength,

        secondMass *
          firstLength *
          secondLength *
          cosDifference
      ],

      [
        secondMass *
          secondLength *
          cos2,

        secondMass *
          firstLength *
          secondLength *
          cosDifference,

        secondMass *
          secondLength *
          secondLength
      ]
    ];

    const relativeAngularVelocity =
      angularVelocity2 -
      angularVelocity1;

    const jointFriction =
      jointDamping *
      relativeAngularVelocity;

    /*
     * M(q) qDDot = RHS(q, qDot, u)
     *
     * Because theta = 0 corresponds to upright,
     * gravity must make theta = 0 unstable.
     */
    const generalizedForces = [
      force +

        combinedMass *
          firstLength *
          sin1 *
          angularVelocity1 *
          angularVelocity1 +

        secondMass *
          secondLength *
          sin2 *
          angularVelocity2 *
          angularVelocity2,

      combinedMass *
        gravity *
        firstLength *
        sin1 -

        secondMass *
          firstLength *
          secondLength *
          sinDifference *
          angularVelocity2 *
          angularVelocity2 -

        firstPivotDamping *
          angularVelocity1 +

        jointFriction,

      secondMass *
        gravity *
        secondLength *
        sin2 +

        secondMass *
          firstLength *
          secondLength *
          sinDifference *
          angularVelocity1 *
          angularVelocity1 -

        secondPivotDamping *
          angularVelocity2 -

        jointFriction
    ];

    const accelerations =
      solveThreeByThree(
        massMatrix,
        generalizedForces
      );

    return [
      velocity,
      accelerations[0],

      angularVelocity1,
      accelerations[1],

      angularVelocity2,
      accelerations[2]
    ];
  }

  /*
   * ------------------------------------------------------------
   * RK4 integration
   * ------------------------------------------------------------
   */

  function addScaled(
    state,
    direction,
    scale
  ) {
    return state.map(
      (value, index) =>
        value +
        direction[index] * scale
    );
  }

  /*
   * This same nonlinear RK4 model is used by both:
   *
   * 1. the visible plant
   * 2. all iLQR rollouts and finite-difference linearizations
   */
  function doublePendulumNext(
    state,
    controlForce,
    dt,
    enforceRail
  ) {
    const k1 =
      stateDerivative(
        state,
        controlForce
      );

    const k2 =
      stateDerivative(
        addScaled(
          state,
          k1,
          0.5 * dt
        ),
        controlForce
      );

    const k3 =
      stateDerivative(
        addScaled(
          state,
          k2,
          0.5 * dt
        ),
        controlForce
      );

    const k4 =
      stateDerivative(
        addScaled(
          state,
          k3,
          dt
        ),
        controlForce
      );

    const nextState =
      state.map(
        (value, index) =>
          value +
          (dt / 6) *
            (
              k1[index] +
              2 * k2[index] +
              2 * k3[index] +
              k4[index]
            )
      );

    nextState[2] =
      wrapAngle(nextState[2]);

    nextState[4] =
      wrapAngle(nextState[4]);

    /*
     * Physical horizontal limits.
     */
    if (enforceRail) {
      if (
        nextState[0] >
        trackLimit
      ) {
        nextState[0] =
          trackLimit;

        nextState[1] =
          Math.min(
            0,
            nextState[1]
          ) *
          0.2;
      }

      if (
        nextState[0] <
        -trackLimit
      ) {
        nextState[0] =
          -trackLimit;

        nextState[1] =
          Math.max(
            0,
            nextState[1]
          ) *
          0.2;
      }
    }

    return nextState;
  }

  /*
   * ------------------------------------------------------------
   * iLQR helpers
   * ------------------------------------------------------------
   */

  function stateDifference(
    firstState,
    secondState
  ) {
    return [
      firstState[0] -
        secondState[0],

      firstState[1] -
        secondState[1],

      wrapAngle(
        firstState[2] -
        secondState[2]
      ),

      firstState[3] -
        secondState[3],

      wrapAngle(
        firstState[4] -
        secondState[4]
      ),

      firstState[5] -
        secondState[5]
    ];
  }

  function addToState(
    state,
    index,
    amount
  ) {
    const output =
      state.slice();

    output[index] += amount;

    if (
      index === 2 ||
      index === 4
    ) {
      output[index] =
        wrapAngle(output[index]);
    }

    return output;
  }

  function dot(
    firstVector,
    secondVector
  ) {
    let value = 0;

    for (
      let index = 0;
      index < firstVector.length;
      index += 1
    ) {
      value +=
        firstVector[index] *
        secondVector[index];
    }

    return value;
  }

  function matrixTimesVector(
    matrix,
    vector
  ) {
    return matrix.map(
      (row) =>
        dot(row, vector)
    );
  }

  function transposeTimesVector(
    matrix,
    vector
  ) {
    const result =
      new Array(
        matrix[0].length
      ).fill(0);

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
          matrix[row][column] *
          vector[row];
      }
    }

    return result;
  }

  /*
   * A^T M A
   */
  function atMa(A, M) {
    const result =
      Array.from(
        {
          length: stateDimension
        },
        () =>
          new Array(
            stateDimension
          ).fill(0)
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
        let value = 0;

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
            value +=
              A[p][i] *
              M[p][q] *
              A[q][j];
          }
        }

        result[i][j] =
          value;
      }
    }

    return result;
  }

  /*
   * B^T M A
   */
  function bTMa(
    B,
    M,
    A
  ) {
    const result =
      new Array(
        stateDimension
      ).fill(0);

    for (
      let column = 0;
      column < stateDimension;
      column += 1
    ) {
      let value = 0;

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
          value +=
            B[p] *
            M[p][q] *
            A[q][column];
        }
      }

      result[column] =
        value;
    }

    return result;
  }

  function symmetrize(matrix) {
    for (
      let row = 0;
      row < stateDimension;
      row += 1
    ) {
      matrix[row][row] +=
        1e-7;

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

        matrix[row][column] =
          average;

        matrix[column][row] =
          average;
      }
    }

    return matrix;
  }

  /*
   * ------------------------------------------------------------
   * Track barrier
   * ------------------------------------------------------------
   */

  function barrierDerivatives(
    position,
    weight
  ) {
    const effectiveLimit =
      trackLimit * 0.965;

    const epsilon = 0.08;

    const rightDistance =
      Math.max(
        epsilon,
        effectiveLimit -
          position
      );

    const leftDistance =
      Math.max(
        epsilon,
        effectiveLimit +
          position
      );

    let cost =
      -weight *
      (
        Math.log(
          rightDistance /
          effectiveLimit
        ) +

        Math.log(
          leftDistance /
          effectiveLimit
        )
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
        1 /
          (
            rightDistance *
            rightDistance
          ) +

        1 /
          (
            leftDistance *
            leftDistance
          )
      );

    const violation =
      Math.max(
        0,
        Math.abs(position) -
          effectiveLimit
      );

    if (
      violation > 0
    ) {
      cost +=
        700 *
        violation *
        violation;

      gradient +=
        Math.sign(position) *
        1400 *
        violation;

      hessian += 1400;
    }

    return {
      cost,
      gradient,
      hessian
    };
  }

  /*
   * ------------------------------------------------------------
   * iLQR cost
   * ------------------------------------------------------------
   */

  function costDerivatives(
    state,
    control,
    terminal
  ) {
    const weights =
      terminal
        ? terminalWeights
        : stageWeights;

    const error = [
      state[0] -
        desiredBoatPosition,

      state[1],

      wrapAngle(state[2]),

      state[3],

      wrapAngle(state[4]),

      state[5]
    ];

    const barrier =
      barrierDerivatives(
        state[0],
        terminal
          ? 0.9
          : 0.16
      );

    const lx =
      error.map(
        (value, index) =>
          2 *
          weights[index] *
          value
      );

    const lxx =
      Array.from(
        {
          length: stateDimension
        },
        (_, row) =>
          Array.from(
            {
              length: stateDimension
            },
            (_, column) =>
              row === column
                ? 2 *
                  weights[row]
                : 0
          )
      );

    lx[0] +=
      barrier.gradient;

    lxx[0][0] +=
      barrier.hessian;

    return {
      lx,
      lxx,

      lu:
        terminal
          ? 0
          : 2 *
            controlWeight *
            control,

      luu:
        terminal
          ? 0
          : 2 *
            controlWeight
    };
  }

  function stageCost(
    state,
    control,
    terminal
  ) {
    const weights =
      terminal
        ? terminalWeights
        : stageWeights;

    const error = [
      state[0] -
        desiredBoatPosition,

      state[1],

      wrapAngle(state[2]),

      state[3],

      wrapAngle(state[4]),

      state[5]
    ];

    let cost = 0;

    for (
      let index = 0;
      index < stateDimension;
      index += 1
    ) {
      cost +=
        weights[index] *
        error[index] *
        error[index];
    }

    cost +=
      barrierDerivatives(
        state[0],
        terminal
          ? 0.9
          : 0.16
      ).cost;

    if (!terminal) {
      cost +=
        controlWeight *
        control *
        control;
    }

    return cost;
  }

  /*
   * ------------------------------------------------------------
   * Nonlinear rollout
   * ------------------------------------------------------------
   */

  function rollout(
    initialState,
    controls
  ) {
    const states = [
      initialState.slice()
    ];

    for (
      let step = 0;
      step < controls.length;
      step += 1
    ) {
      states.push(
        doublePendulumNext(
          states[step],
          controls[step],
          planningDt,
          false
        )
      );
    }

    return states;
  }

  function trajectoryCost(
    states,
    controls
  ) {
    let totalCost = 0;

    for (
      let step = 0;
      step < controls.length;
      step += 1
    ) {
      totalCost +=
        stageCost(
          states[step],
          controls[step],
          false
        );
    }

    totalCost +=
      stageCost(
        states[
          states.length - 1
        ],
        0,
        true
      );

    return totalCost;
  }

  /*
   * ------------------------------------------------------------
   * Numerical dynamics linearization
   * ------------------------------------------------------------
   *
   * Linearizes exactly the same nonlinear RK4 model
   * used for the animation.
   * ------------------------------------------------------------
   */

  function linearizeDynamics(
    state,
    control
  ) {
    const stateEpsilon = [
      0.0025,
      0.004,
      0.002,
      0.004,
      0.002,
      0.004
    ];

    const controlEpsilon =
      0.08;

    const A =
      Array.from(
        {
          length: stateDimension
        },
        () =>
          new Array(
            stateDimension
          ).fill(0)
      );

    for (
      let column = 0;
      column < stateDimension;
      column += 1
    ) {
      const plusState =
        addToState(
          state,
          column,
          stateEpsilon[column]
        );

      const minusState =
        addToState(
          state,
          column,
          -stateEpsilon[column]
        );

      const plusResult =
        doublePendulumNext(
          plusState,
          control,
          planningDt,
          false
        );

      const minusResult =
        doublePendulumNext(
          minusState,
          control,
          planningDt,
          false
        );

      const difference =
        stateDifference(
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
          (
            2 *
            stateEpsilon[column]
          );
      }
    }

    const plusControl =
      doublePendulumNext(
        state,
        control +
          controlEpsilon,
        planningDt,
        false
      );

    const minusControl =
      doublePendulumNext(
        state,
        control -
          controlEpsilon,
        planningDt,
        false
      );

    const controlDifference =
      stateDifference(
        plusControl,
        minusControl
      );

    const B =
      controlDifference.map(
        (value) =>
          value /
          (
            2 *
            controlEpsilon
          )
      );

    return {
      A,
      B
    };
  }

  /*
   * ------------------------------------------------------------
   * Initial trajectory for iLQR
   * ------------------------------------------------------------
   *
   * iLQR is a local optimizer and benefits from
   * a useful initial control sequence.
   *
   * Near upright, use stabilizing feedback.
   *
   * Farther away, use energy pumping.
   *
   * This is only the seed.
   * iLQR subsequently optimizes the whole sequence.
   * ------------------------------------------------------------
   */

  function seedControl(
    state,
    step
  ) {
    const position =
      state[0];

    const velocity =
      state[1];

    const angle1 =
      wrapAngle(state[2]);

    const angularVelocity1 =
      state[3];

    const angle2 =
      wrapAngle(state[4]);

    const angularVelocity2 =
      state[5];

    const maxAngle =
      Math.max(
        Math.abs(angle1),
        Math.abs(angle2)
      );

    /*
     * Local stabilizing seed.
     */
    const localControl =
      -2.4 * position -
      3.2 * velocity +

      58 * angle1 +
      13 * angularVelocity1 +

      34 * angle2 +
      9 * angularVelocity2;

    /*
     * Mechanical energy relative to upright.
     */
    const firstEnergy =
      0.5 *
        Math.pow(
          firstLength *
            angularVelocity1,
          2
        ) +

      gravity *
        firstLength *
        (
          Math.cos(angle1) -
          1
        );

    const secondEnergy =
      0.5 *
        Math.pow(
          secondLength *
            angularVelocity2,
          2
        ) +

      gravity *
        secondLength *
        (
          Math.cos(angle2) -
          1
        );

    const swingControl =
      12 *
        angularVelocity1 *
        Math.cos(angle1) *
        firstEnergy +

      8 *
        angularVelocity2 *
        Math.cos(angle2) *
        secondEnergy -

      1.2 * position -
      1.1 * velocity +

      8 *
        Math.sin(
          performance.now() *
            0.0017 +
          step *
            0.36
        );

    /*
     * Blend smoothly between swing-up
     * and local stabilization.
     */
    const blend =
      clamp(
        (
          1.25 -
          maxAngle
        ) /
        0.85,
        0,
        1
      );

    return clamp(
      blend *
        localControl +

      (
        1 -
        blend
      ) *
        swingControl,

      -maxControlForce,
      maxControlForce
    );
  }

  function initialControlSequence(
    state
  ) {
    const controls = [];

    let simulatedState =
      state.slice();

    for (
      let step = 0;
      step < horizonSteps;
      step += 1
    ) {
      const control =
        seedControl(
          simulatedState,
          step
        );

      controls.push(control);

      simulatedState =
        doublePendulumNext(
          simulatedState,
          control,
          planningDt,
          false
        );
    }

    return controls;
  }

  /*
   * ------------------------------------------------------------
   * ITERATIVE LQR
   * ------------------------------------------------------------
   *
   * Each iteration:
   *
   * 1. nonlinear rollout
   * 2. finite-difference linearization
   * 3. backward LQR pass
   * 4. feedforward + feedback update
   * 5. nonlinear line search
   * ------------------------------------------------------------
   */

  function optimizeWithILQR(
    initialState,
    initialControls
  ) {
    let controls =
      initialControls.slice();

    let states =
      rollout(
        initialState,
        controls
      );

    let bestCost =
      trajectoryCost(
        states,
        controls
      );

    for (
      let iteration = 0;
      iteration < ilqrIterations;
      iteration += 1
    ) {
      const feedforward =
        new Array(horizonSteps);

      const feedback =
        new Array(horizonSteps);

      const terminal =
        costDerivatives(
          states[
            states.length - 1
          ],
          0,
          true
        );

      let valueGradient =
        terminal.lx.slice();

      let valueHessian =
        terminal.lxx.map(
          (row) =>
            row.slice()
        );

      let failed = false;

      /*
       * Backward pass.
       */
      for (
        let step =
          horizonSteps - 1;
        step >= 0;
        step -= 1
      ) {
        const linearization =
          linearizeDynamics(
            states[step],
            controls[step]
          );

        const A =
          linearization.A;

        const B =
          linearization.B;

        const derivatives =
          costDerivatives(
            states[step],
            controls[step],
            false
          );

        const futureGradient =
          transposeTimesVector(
            A,
            valueGradient
          );

        const Qx =
          derivatives.lx.map(
            (value, index) =>
              value +
              futureGradient[index]
          );

        const Qu =
          derivatives.lu +
          dot(
            B,
            valueGradient
          );

        const hessianTimesB =
          matrixTimesVector(
            valueHessian,
            B
          );

        const Quu =
          derivatives.luu +

          dot(
            B,
            hessianTimesB
          ) +

          0.0012;

        if (
          !Number.isFinite(Quu) ||
          Quu <= 1e-9
        ) {
          failed = true;
          break;
        }

        const futureQxx =
          atMa(
            A,
            valueHessian
          );

        const Qxx =
          derivatives.lxx.map(
            (
              row,
              rowIndex
            ) =>
              row.map(
                (
                  value,
                  columnIndex
                ) =>
                  value +
                  futureQxx
                    [rowIndex]
                    [columnIndex]
              )
          );

        const Qux =
          bTMa(
            B,
            valueHessian,
            A
          );

        const feedforwardControl =
          -Qu / Quu;

        const feedbackControl =
          Qux.map(
            (value) =>
              -value / Quu
          );

        feedforward[step] =
          feedforwardControl;

        feedback[step] =
          feedbackControl;

        const nextGradient =
          new Array(
            stateDimension
          ).fill(0);

        const nextHessian =
          Array.from(
            {
              length:
                stateDimension
            },
            () =>
              new Array(
                stateDimension
              ).fill(0)
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

            feedbackControl[i] *
              Qu +

            Qux[i] *
              feedforwardControl;

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

              feedbackControl[i] *
                Qux[j] +

              Qux[i] *
                feedbackControl[j];
          }
        }

        valueGradient =
          nextGradient;

        valueHessian =
          symmetrize(
            nextHessian
          );
      }

      if (failed) {
        break;
      }

      /*
       * Nonlinear forward line search.
       */
      let accepted = false;

      const lineSearchValues = [
        1,
        0.55,
        0.25,
        0.1,
        0.04
      ];

      for (
        const alpha
        of lineSearchValues
      ) {
        const candidateControls = [];

        const candidateStates = [
          initialState.slice()
        ];

        for (
          let step = 0;
          step < horizonSteps;
          step += 1
        ) {
          const difference =
            stateDifference(
              candidateStates[step],
              states[step]
            );

          const correction =
            alpha *
              feedforward[step] +

            dot(
              feedback[step],
              difference
            );

          const candidateControl =
            clamp(
              controls[step] +
                correction,

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
          Number.isFinite(
            candidateCost
          ) &&
          candidateCost <
            bestCost
        ) {
          controls =
            candidateControls;

          states =
            candidateStates;

          bestCost =
            candidateCost;

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

  /*
   * ------------------------------------------------------------
   * Receding-horizon iLQR
   * ------------------------------------------------------------
   */

  function computeControl() {
    const state =
      currentState();

    let controls;

    if (
      !controlPlan ||
      controlPlan.length !==
        horizonSteps
    ) {
      controls =
        initialControlSequence(
          state
        );
    } else {
      controls =
        controlPlan.slice();

      const firstAngle =
        Math.abs(
          wrapAngle(
            state[2]
          )
        );

      const secondAngle =
        Math.abs(
          wrapAngle(
            state[4]
          )
        );

      if (
        firstAngle > 0.75 ||
        secondAngle > 0.75
      ) {
        const seed =
          initialControlSequence(
            state
          );

        for (
          let step = 0;
          step < horizonSteps;
          step += 1
        ) {
          controls[step] =
            0.70 *
              controls[step] +

            0.30 *
              seed[step];
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

  /*
   * ------------------------------------------------------------
   * Actual plant step
   * ------------------------------------------------------------
   */

  function stepDynamics(
    dt,
    controlForce
  ) {
    let externalForce = 0;

    if (
      disturbanceElapsed <
      disturbanceDuration
    ) {
      disturbanceElapsed =
        Math.min(
          disturbanceDuration,
          disturbanceElapsed + dt
        );

      const progress =
        disturbanceElapsed /
        disturbanceDuration;

      /*
       * Smooth half-sine force pulse.
       */
      externalForce =
        disturbancePeakForce *
        Math.sin(
          Math.PI *
          progress
        );

      disturbanceFlash = 1;
    } else {
      disturbancePeakForce = 0;

      disturbanceFlash =
        Math.max(
          0,
          disturbanceFlash -
            2 * dt
        );
    }

    /*
     * Both controller and disturbance enter
     * through the same horizontal boat-force channel.
     */
    const totalForce =
      clamp(
        controlForce +
          externalForce,

        -maxTotalForce,
        maxTotalForce
      );

    setCurrentState(
      doublePendulumNext(
        currentState(),
        totalForce,
        dt,
        true
      )
    );
  }

  /*
   * ------------------------------------------------------------
   * Drawing helpers
   * ------------------------------------------------------------
   */

  function modelXToScreenX(
    position
  ) {
    const halfRange =
      width * 0.47;

    return (
      width * 0.5 +
      (
        position /
        trackLimit
      ) *
      halfRange
    );
  }

  function roundRect(
    context,
    px,
    py,
    boxWidth,
    boxHeight,
    radius
  ) {
    const r =
      Math.min(
        radius,
        boxWidth / 2,
        boxHeight / 2
      );

    context.beginPath();

    context.moveTo(
      px + r,
      py
    );

    context.lineTo(
      px +
        boxWidth -
        r,
      py
    );

    context.quadraticCurveTo(
      px + boxWidth,
      py,
      px + boxWidth,
      py + r
    );

    context.lineTo(
      px + boxWidth,
      py +
        boxHeight -
        r
    );

    context.quadraticCurveTo(
      px + boxWidth,
      py + boxHeight,
      px +
        boxWidth -
        r,
      py + boxHeight
    );

    context.lineTo(
      px + r,
      py + boxHeight
    );

    context.quadraticCurveTo(
      px,
      py + boxHeight,
      px,
      py +
        boxHeight -
        r
    );

    context.lineTo(
      px,
      py + r
    );

    context.quadraticCurveTo(
      px,
      py,
      px + r,
      py
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
      "rgba(255,255,255,0.025)"
    );

    gradient.addColorStop(
      1,
      "rgba(255,255,255,0.008)"
    );

    ctx.fillStyle =
      gradient;

    ctx.fillRect(
      0,
      0,
      width,
      height
    );
  }

  /*
   * Animated water line.
   */
  function drawWaterLine(y) {
    const left =
      modelXToScreenX(
        -trackLimit
      );

    const right =
      modelXToScreenX(
        trackLimit
      );

    ctx.save();

    ctx.strokeStyle =
      "rgba(230,245,255,0.22)";

    ctx.lineWidth = 1.4;

    ctx.beginPath();

    const numberOfSegments = 40;

    for (
      let index = 0;
      index <= numberOfSegments;
      index += 1
    ) {
      const ratio =
        index /
        numberOfSegments;

      const px =
        left +
        (
          right -
          left
        ) *
        ratio;

      const wave =
        Math.sin(
          ratio *
            Math.PI *
            10 +
          performance.now() *
            0.0018
        ) *
        1.25;

      if (
        index === 0
      ) {
        ctx.moveTo(
          px,
          y + wave
        );
      } else {
        ctx.lineTo(
          px,
          y + wave
        );
      }
    }

    ctx.stroke();

    ctx.restore();
  }

  /*
   * Boat hull and small cabin.
   */
  function drawBoat(
    centerX,
    waterY,
    boatWidth,
    boatHeight
  ) {
    const left =
      centerX -
      boatWidth / 2;

    const right =
      centerX +
      boatWidth / 2;

    const hullTop =
      waterY -
      boatHeight *
        0.34;

    const hullBottom =
      waterY +
      boatHeight *
        0.12;

    ctx.save();

    /*
     * Shadow beneath boat.
     */
    ctx.fillStyle =
      "rgba(0,0,0,0.14)";

    ctx.beginPath();

    ctx.ellipse(
      centerX,
      waterY +
        boatHeight *
        0.40,
      boatWidth *
        0.48,
      boatHeight *
        0.18,
      0,
      0,
      Math.PI * 2
    );

    ctx.fill();

    /*
     * Hull.
     */
    const hullGradient =
      ctx.createLinearGradient(
        left,
        hullTop,
        right,
        hullBottom
      );

    hullGradient.addColorStop(
      0,
      "rgba(250,251,253,0.62)"
    );

    hullGradient.addColorStop(
      1,
      "rgba(200,220,232,0.46)"
    );

    ctx.fillStyle =
      hullGradient;

    ctx.strokeStyle =
      "rgba(245,250,255,0.62)";

    ctx.lineWidth = 1.2;

    ctx.beginPath();

    ctx.moveTo(
      left -
        boatWidth *
        0.07,
      hullTop
    );

    ctx.lineTo(
      right -
        boatWidth *
        0.08,
      hullTop
    );

    ctx.quadraticCurveTo(
      right +
        boatWidth *
        0.16,
      hullTop +
        boatHeight *
        0.10,
      right,
      hullBottom
    );

    ctx.lineTo(
      left +
        boatWidth *
        0.16,
      hullBottom
    );

    ctx.quadraticCurveTo(
      left -
        boatWidth *
        0.12,
      hullBottom,
      left -
        boatWidth *
        0.07,
      hullTop
    );

    ctx.closePath();

    ctx.fill();
    ctx.stroke();

    /*
     * Cabin.
     */
    const cabinWidth =
      boatWidth * 0.26;

    const cabinHeight =
      boatHeight * 0.26;

    ctx.fillStyle =
      "rgba(100,120,145,0.38)";

    ctx.strokeStyle =
      "rgba(235,246,252,0.26)";

    ctx.lineWidth = 0.8;

    roundRect(
      ctx,
      left +
        boatWidth *
        0.27,
      hullTop -
        cabinHeight,
      cabinWidth,
      cabinHeight,
      4
    );

    ctx.fill();
    ctx.stroke();

    /*
     * Cabin window.
     */
    ctx.fillStyle =
      "rgba(220,242,250,0.22)";

    roundRect(
      ctx,
      left +
        boatWidth *
        0.31,
      hullTop -
        cabinHeight *
        0.78,
      cabinWidth *
        0.43,
      cabinHeight *
        0.42,
      2
    );

    ctx.fill();

    ctx.restore();
  }

  /*
   * Draw external push indicator.
   */
  function drawDisturbanceArrow(
    boatCenterX,
    waterY,
    boatWidth,
    boatHeight,
    scale
  ) {
    if (
      disturbanceFlash <= 0
    ) {
      return;
    }

    const sourceSide =
      disturbanceSourceSide || 1;

    const forceDirection =
      -sourceSide;

    const arrowLength =
      clamp(
        scale * 0.22,
        26,
        42
      );

    const contactX =
      boatCenterX +
      sourceSide *
        boatWidth *
        0.58;

    const startX =
      contactX +
      sourceSide *
        (
          arrowLength +
          boatWidth *
            0.08
        );

    const y =
      waterY -
      boatHeight *
        0.82;

    const alpha =
      0.65 *
      disturbanceFlash;

    const headSize =
      clamp(
        scale * 0.04,
        5,
        7
      );

    ctx.save();

    ctx.strokeStyle =
      `rgba(235,248,255,${alpha})`;

    ctx.fillStyle =
      `rgba(235,248,255,${alpha})`;

    ctx.lineWidth = 1.8;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();

    ctx.moveTo(
      startX,
      y
    );

    ctx.lineTo(
      contactX,
      y
    );

    ctx.stroke();

    ctx.beginPath();

    ctx.moveTo(
      contactX,
      y
    );

    ctx.lineTo(
      contactX -
        forceDirection *
        headSize,
      y -
        headSize *
        0.55
    );

    ctx.lineTo(
      contactX -
        forceDirection *
        headSize,
      y +
        headSize *
        0.55
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
      `rgba(238,247,252,${alpha})`;

    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";

    ctx.beginPath();

    ctx.moveTo(
      startX,
      startY
    );

    ctx.lineTo(
      endX,
      endY
    );

    ctx.stroke();

    /*
     * Subtle cool highlight.
     */
    ctx.strokeStyle =
      `rgba(125,211,252,${
        alpha * 0.24
      })`;

    ctx.lineWidth = 0.9;

    ctx.beginPath();

    ctx.moveTo(
      startX,
      startY
    );

    ctx.lineTo(
      endX,
      endY
    );

    ctx.stroke();
  }

  function drawJoint(
    px,
    py,
    radius,
    brightness
  ) {
    const gradient =
      ctx.createRadialGradient(
        px -
          radius *
          0.25,
        py -
          radius *
          0.25,
        1,
        px,
        py,
        radius
      );

    gradient.addColorStop(
      0,
      `rgba(255,255,255,${brightness})`
    );

    gradient.addColorStop(
      0.5,
      "rgba(216,233,239,0.60)"
    );

    gradient.addColorStop(
      1,
      "rgba(146,182,194,0.38)"
    );

    ctx.fillStyle =
      gradient;

    ctx.beginPath();

    ctx.arc(
      px,
      py,
      radius,
      0,
      Math.PI * 2
    );

    ctx.fill();
  }

  /*
   * ------------------------------------------------------------
   * Double inverted pendulum drawing
   * ------------------------------------------------------------
   */

  function drawDoublePendulum() {
    const scale =
      Math.min(
        width,
        height
      );

    const waterY =
      height * 0.78;

    const boatCenterX =
      modelXToScreenX(
        boatPosition
      );

    const boatWidth =
      clamp(
        scale * 0.42,
        72,
        116
      );

    const boatHeight =
      clamp(
        scale * 0.15,
        18,
        29
      );

    /*
     * Pendulum base pivot is attached to the boat.
     */
    const pivotX =
      boatCenterX +
      boatWidth * 0.03;

    const pivotY =
      waterY -
      boatHeight * 0.70;

    /*
     * Visual lengths are shorter than physical lengths
     * because the hero canvas is shallow.
     */
    const firstDrawLength =
      clamp(
        scale * 0.245,
        38,
        63
      );

    const secondDrawLength =
      clamp(
        scale * 0.21,
        33,
        55
      );

    /*
     * Absolute-angle geometry.
     */
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

    /*
     * End-point trail.
     */
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

    /*
     * Water.
     */
    drawWaterLine(waterY);

    /*
     * Boat.
     */
    drawBoat(
      boatCenterX,
      waterY,
      boatWidth,
      boatHeight
    );

    /*
     * Disturbance indicator.
     */
    drawDisturbanceArrow(
      boatCenterX,
      waterY,
      boatWidth,
      boatHeight,
      scale
    );

    /*
     * Fading second-bob trajectory.
     */
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
        index /
        bobTrail.length;

      ctx.strokeStyle =
        `rgba(182,232,242,${
          0.008 +
          age * 0.14
        })`;

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

    /*
     * Pendulum links.
     */
    drawRod(
      pivotX,
      pivotY,
      firstJointX,
      firstJointY,
      0.72
    );

    drawRod(
      firstJointX,
      firstJointY,
      secondBobX,
      secondBobY,
      0.64
    );

    /*
     * Pivot and masses.
     */
    drawJoint(
      pivotX,
      pivotY,
      3.5,
      0.76
    );

    drawJoint(
      firstJointX,
      firstJointY,
      6.0,
      0.80
    );

    drawJoint(
      secondBobX,
      secondBobY,
      8.1,
      0.86
    );

    ctx.restore();
  }

  /*
   * ------------------------------------------------------------
   * Animation
   * ------------------------------------------------------------
   */

  function animate(now) {
    if (
      lastTime === null
    ) {
      lastTime = now;
    }

    const dt =
      Math.min(
        0.022,
        Math.max(
          0.001,
          (
            now -
            lastTime
          ) /
          1000
        )
      );

    lastTime = now;

    /*
     * Receding-horizon iterative LQR.
     *
     * Re-optimize regularly while warm-starting
     * from the previously computed control sequence.
     */
    if (
      frameNumber % 3 === 0 ||
      !controlPlan
    ) {
      requestedControl =
        computeControl();
    }

    frameNumber += 1;

    /*
     * No artificial actuator lag:
     *
     * iLQR predicts exactly the same force channel
     * used by the visible nonlinear plant.
     */
    const substeps = 3;

    const substepDt =
      dt / substeps;

    for (
      let step = 0;
      step < substeps;
      step += 1
    ) {
      stepDynamics(
        substepDt,
        requestedControl
      );
    }

    drawBackground();
    drawDoublePendulum();

    requestAnimationFrame(
      animate
    );
  }
})();