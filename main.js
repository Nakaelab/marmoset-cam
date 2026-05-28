import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

// --- Application State ---
let scene, camera, renderer, controls;
let model, mixer, activeAction;
let skeletonHelper, eyeHelper;
let eyeL = null, eyeR = null, headBone = null;

// Web camera state variables
let webcamStream = null;
let webcamVideoElement = null;
let webcamTexture = null;
let virtualMonitorGroup = null;

// Camera mode: 'orbit' or 'pov'
let cameraMode = 'orbit';

// Calibrated POV offsets
const defaults = {
  eyeTarget: 'center',
  fov: 120,
  offsetX: -0.005,
  offsetY: -0.005,
  offsetZ: 0.035,
  pitch: -32,
  yaw: 0,
  roll: 0,
  speed: 1.0,
  lighting: 'studio'
};

let povSettings = { ...defaults };
let isUserDraggingTimeline = false;
let clock = new THREE.Clock();

// Variables to track animation synchronization from parent
let lastReceivedSyncTime = null;
let lastReceivedSyncTimestamp = null;
let isParentPaused = false;

// Embed mode detection
const isEmbedMode = new URLSearchParams(window.location.search).has('embed');

// Lighting elements holder
const lights = {
  ambient: null,
  hemi: null,
  dir1: null,
  dir2: null,
  spot: null
};
let gridHelper;

// --- Initialize Three.js ---
function init() {
  const canvas = document.getElementById('webgl-canvas');
  
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa5a89c);
  scene.fog = null;

  // Main Camera
  // Since cameraMode starts as 'orbit', set initial FOV to 45.
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.002, 100);
  // Match reference site camera-orbit="270deg 75deg 3.5m" and camera-target="0m 0.85m 0.11m"
  // 270deg theta = looking from +X side, 75deg phi = slightly above
  // radius 3.5m -> in model space (cm scale) this is ~3.5 units
  const initTheta = THREE.MathUtils.degToRad(270);
  const initPhi = THREE.MathUtils.degToRad(75);
  const initRadius = 3.5;
  camera.position.set(
    initRadius * Math.sin(initPhi) * Math.sin(initTheta) + 0,   // X: target.x + offset
    initRadius * Math.cos(initPhi) + 0.85,                       // Y: target.y + vertical
    initRadius * Math.sin(initPhi) * Math.cos(initTheta) + 0.11  // Z: target.z + offset
  );

  // Controls (for Orbit View)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 + 0.1; // Don't go too far below ground
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  // Set the orbit target to match the reference camera-target="0m 0.85m 0.11m"
  controls.target.set(0, 0.85, 0.11);

  // Setup basic grid (hidden by default to match reference environment)
  gridHelper = new THREE.GridHelper(10, 50, 0x475569, 0x1e293b);
  gridHelper.position.y = -0.5; // Will adjust based on model load bounds
  gridHelper.visible = document.getElementById('check-grid').checked;
  scene.add(gridHelper);

  // Setup Lights
  setupLights();
  setLightingPreset(defaults.lighting);

  // Setup Environment map for reflections
  setupEnvironment();

  // Load Model
  loadModel();

  // Setup Event Listeners
  window.addEventListener('resize', onWindowResize);
  setupUIEventListeners();

  // Listen for sync messages from the parent window
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'sync-time') {
      lastReceivedSyncTime = data.currentTime;
      lastReceivedSyncTimestamp = performance.now();
      isParentPaused = data.paused;
      if (mixer) {
        mixer.setTime(data.currentTime);
      }
    }
  });

  // Embed mode: hide all UI overlay
  if (isEmbedMode) {
    const uiOverlay = document.getElementById('ui-overlay');
    if (uiOverlay) uiOverlay.style.display = 'none';
  }

  // Start Loop
  animate();
}

// --- Setup Lights ---
function setupLights() {
  lights.ambient = new THREE.AmbientLight(0xffffff, 0);
  scene.add(lights.ambient);

  lights.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
  scene.add(lights.hemi);

  lights.dir1 = new THREE.DirectionalLight(0xffffff, 0);
  lights.dir1.castShadow = true;
  lights.dir1.shadow.mapSize.width = 2048;
  lights.dir1.shadow.mapSize.height = 2048;
  lights.dir1.shadow.camera.near = 0.1;
  lights.dir1.shadow.camera.far = 10;
  lights.dir1.shadow.camera.left = -1;
  lights.dir1.shadow.camera.right = 1;
  lights.dir1.shadow.camera.top = 1;
  lights.dir1.shadow.camera.bottom = -1;
  lights.dir1.shadow.bias = -0.0005;
  scene.add(lights.dir1);

  lights.dir2 = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(lights.dir2);

  lights.spot = new THREE.SpotLight(0xffffff, 0);
  lights.spot.castShadow = true;
  lights.spot.angle = Math.PI / 6;
  lights.spot.penumbra = 0.3;
  lights.spot.shadow.mapSize.width = 1024;
  lights.spot.shadow.mapSize.height = 1024;
  scene.add(lights.spot);
}

// --- Setup Environment map for reflections ---
function setupEnvironment() {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const envScene = new THREE.Scene();
  
  // Ambient light in environment
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
  envScene.add(ambientLight);

  // Bright light from top-front-right
  const dirLight1 = new THREE.DirectionalLight(0xffffff, 4.0);
  dirLight1.position.set(2, 5, 3);
  envScene.add(dirLight1);

  // Soft light from opposite side
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 2.0);
  dirLight2.position.set(-2, 3, -3);
  envScene.add(dirLight2);

  // Light grey sky background for high-quality ambient reflection
  envScene.background = new THREE.Color(0xeeeeee);

  const envMap = pmremGenerator.fromScene(envScene).texture;
  scene.environment = envMap;
  
  pmremGenerator.dispose();
}

// --- Set Lighting Presets ---
function setLightingPreset(preset) {
  // Reset all intensities
  lights.ambient.intensity = 0;
  lights.hemi.intensity = 0;
  lights.dir1.intensity = 0;
  lights.dir2.intensity = 0;
  lights.spot.intensity = 0;
  lights.spot.visible = false;
  lights.dir1.visible = false;
  lights.dir2.visible = false;

  switch (preset) {
    case 'studio':
      scene.background.setHex(0xa5a89c);
      if (scene.fog) scene.fog.color.setHex(0xa5a89c);
      
      lights.hemi.color.setHex(0xffffff);
      lights.hemi.groundColor.setHex(0x2d3748);
      lights.hemi.intensity = 1.0;

      lights.dir1.visible = true;
      lights.dir1.color.setHex(0xffffff);
      lights.dir1.intensity = 1.8;
      lights.dir1.position.set(1.5, 3.0, 1.5);

      lights.dir2.visible = true;
      lights.dir2.color.setHex(0xa5b4fc);
      lights.dir2.intensity = 0.6;
      lights.dir2.position.set(-1.5, 1.0, -1.5);
      break;

    case 'sunset':
      scene.background.setHex(0x1a0b2e);
      scene.fog.color.setHex(0x1a0b2e);

      lights.hemi.color.setHex(0xfeb47b);
      lights.hemi.groundColor.setHex(0x3a1c5d);
      lights.hemi.intensity = 0.8;

      lights.dir1.visible = true;
      lights.dir1.color.setHex(0xff7e5f);
      lights.dir1.intensity = 2.8;
      lights.dir1.position.set(2.0, 1.0, 1.0);

      lights.dir2.visible = true;
      lights.dir2.color.setHex(0x8a2be2);
      lights.dir2.intensity = 1.2;
      lights.dir2.position.set(-2.0, 1.5, -1.0);
      break;

    case 'forest':
      scene.background.setHex(0x050c0a);
      scene.fog.color.setHex(0x050c0a);

      lights.hemi.color.setHex(0xd4fc79);
      lights.hemi.groundColor.setHex(0x1e3f20);
      lights.hemi.intensity = 0.9;

      lights.dir1.visible = true;
      lights.dir1.color.setHex(0xe0ece0);
      lights.dir1.intensity = 2.0;
      lights.dir1.position.set(0.5, 4.0, 1.0);

      lights.dir2.visible = true;
      lights.dir2.color.setHex(0x2d5a27);
      lights.dir2.intensity = 0.8;
      lights.dir2.position.set(-2.0, 0.5, -2.0);
      break;

    case 'dark':
      scene.background.setHex(0x020205);
      scene.fog.color.setHex(0x020205);

      lights.ambient.color.setHex(0x0f172a);
      lights.ambient.intensity = 0.4;

      lights.spot.visible = true;
      lights.spot.color.setHex(0xa5b4fc);
      lights.spot.intensity = 8.0;
      lights.spot.position.set(0, 3.0, 0);
      lights.spot.target.position.set(0, 0, 0);
      break;
  }
}

// --- Load GLB Model ---
function loadModel() {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  const statusEl = document.getElementById('load-status');
  
  // Use GLB loader to load the self-contained asset
  loader.load(
    './outputkkj.glb',
    (gltf) => {
      model = gltf.scene;
      scene.add(model);

      // Traversal to set up shadows, find bones, and adjust materials
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          
          // Handle material(s) — could be a single material or an array
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((mat) => {
            if (!mat) return;

            // Align materials with the 3D Experimental Environment color and transparency exactly
            if (mat.name === 'PaletteMaterial001') {
              // Outer walls/room (opaque dark grey/black)
              mat.transparent = false;
              mat.opacity = 1.0;
              mat.depthWrite = true;
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
              console.log(`Opaque outer room applied to: ${mat.name}`);
            }
            else if (mat.name === 'PaletteMaterial002') {
              // Trays/internal shelves (transparent white/light grey)
              mat.transparent = true;
              mat.opacity = 0.2;
              mat.depthWrite = false;
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
              console.log(`Transparent tray/shelf applied to: ${mat.name}`);
            }
            else if (mat.name === 'PaletteMaterial003') {
              // Inner cage side sheets (transparent refractive glass)
              mat.transparent = true;
              mat.opacity = 0.99;
              mat.depthWrite = false;
              mat.side = THREE.DoubleSide;
              if (mat.transmission !== undefined) {
                mat.transmission = 1.0;
                mat.ior = 1.4;
              }
              mat.needsUpdate = true;
              console.log(`Clean glass applied to: ${mat.name}`);
            }
            else if (mat.name === 'PaletteMaterial004') {
              // Green wall/panel (transparent green)
              mat.transparent = true;
              mat.opacity = 0.8;
              mat.depthWrite = false;
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
              console.log(`Thin green panel applied to: ${mat.name}`);
            }
            else if (
              mat.name === 'PaletteMaterial005' ||
              mat.name === 'PaletteMaterial006' ||
              mat.name === 'PaletteMaterial007'
            ) {
              // Cage pillars, frames, grids/wires, and light bar
              // Keep GLTF original material values (specular, IOR, emissive)
              // to match model-viewer rendering on the reference site
              mat.transparent = false;
              mat.opacity = 1.0;
              mat.depthWrite = true;
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
              console.log(`Structure material preserved as GLTF original: ${mat.name}`);
            }
          });
        }
        
        // Find Eye and Head bones
        const nameClean = child.name.toLowerCase().replace('_', '.');
        if (nameClean === 'eye.l' || child.name === 'Eye.L') eyeL = child;
        if (nameClean === 'eye.r' || child.name === 'Eye.R') eyeR = child;
        if (nameClean === 'head' || child.name === 'Head') headBone = child;
      });

      console.log('Detected bones:', {
        eyeL: eyeL ? eyeL.name : 'Not Found',
        eyeR: eyeR ? eyeR.name : 'Not Found',
        headBone: headBone ? headBone.name : 'Not Found'
      });

      // Position grid floor underneath the model bottom boundary
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      
      gridHelper.position.y = box.min.y;
      
      // Keep the fixed orbit target matching the reference site's camera-target
      // controls.target is already set to (0, 0.85, 0.11) during init
      controls.update();

      // Set SpotLight target if minimal dark preset is active
      lights.spot.target = model;

      // Skeleton helper setup
      skeletonHelper = new THREE.SkeletonHelper(model);
      skeletonHelper.visible = document.getElementById('check-bones').checked;
      scene.add(skeletonHelper);

      // Create Custom Sight Cone Helper for visual feedback
      createEyeSightHelper();

      // Setup Animation Mixer
      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        activeAction = mixer.clipAction(gltf.animations[0]);
        activeAction.play();
        
        // Set up timeline range
        const totalDuration = gltf.animations[0].duration;
        document.getElementById('time-total').innerText = totalDuration.toFixed(1) + 's';
        
        // Listen for timeline updates
        activeAction.getMixer().addEventListener('loop', () => {
          if (!isUserDraggingTimeline) {
            document.getElementById('slider-timeline').value = 0;
          }
        });
      }

      // Update loading status
      if (statusEl) {
        statusEl.innerText = 'Model Loaded';
        statusEl.style.color = '#10b981'; // Green
        setTimeout(() => {
          statusEl.style.opacity = '0';
          statusEl.style.transition = 'opacity 1s ease';
        }, 3000);
      }

      // Embed mode: auto-switch to POV
      if (isEmbedMode) {
        cameraMode = 'pov';
        controls.enabled = false;
        if (eyeHelper) eyeHelper.visible = false;
        camera.fov = 120;
        camera.updateProjectionMatrix();
      }

      console.log('Model loaded successfully!');
    },
    (xhr) => {
      const pct = (xhr.loaded / xhr.total) * 100;
      if (statusEl) {
        statusEl.innerText = `Loading Model... (${pct.toFixed(0)}%)`;
      }
      console.log(`Loading model: ${pct.toFixed(1)}%`);
    },
    (error) => {
      if (statusEl) {
        statusEl.innerText = 'Loading Failed: ' + error.message;
        statusEl.style.color = '#ef4444'; // Red
      }
      console.error('Error loading model:', error);
    }
  );
}

// --- Create Custom Eye Sight Helper ---
function createEyeSightHelper() {
  // A sleek transparent yellow wireframe cone pointing forward to show gaze
  const geometry = new THREE.ConeGeometry(0.04, 0.3, 16);
  // Shift geometry pivot so it originates from the apex rather than the center
  geometry.translate(0, -0.15, 0);
  
  const material = new THREE.MeshBasicMaterial({
    color: 0xf59e0b,
    wireframe: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false
  });

  eyeHelper = new THREE.Mesh(geometry, material);
  scene.add(eyeHelper);
  
  // Set default visibility based on UI checkbox
  eyeHelper.visible = document.getElementById('check-eye-helper').checked && cameraMode === 'orbit';
}

// --- UI Event Listeners ---
function setupUIEventListeners() {
  // Camera Mode Toggle
  const btnOrbit = document.getElementById('btn-orbit');
  const btnPOV = document.getElementById('btn-pov');
  const povSettingsSec = document.getElementById('pov-settings');
  const currentModeBadge = document.getElementById('current-mode-badge');
  const helpText = document.getElementById('help-text');

  btnOrbit.addEventListener('click', () => {
    cameraMode = 'orbit';
    btnOrbit.classList.add('active');
    btnPOV.classList.remove('active');
    povSettingsSec.classList.add('disabled-opacity');
    currentModeBadge.innerText = 'Orbit Mode';
    helpText.innerText = '💡 Drag with left mouse button to rotate, right button to pan, and scroll wheel to zoom.';
    
    // Reset camera to standard orbit position
    controls.enabled = true;
    camera.fov = 45;
    camera.updateProjectionMatrix();
    
    if (eyeHelper) {
      eyeHelper.visible = document.getElementById('check-eye-helper').checked;
    }
  });

  btnPOV.addEventListener('click', () => {
    cameraMode = 'pov';
    btnPOV.classList.add('active');
    btnOrbit.classList.remove('active');
    povSettingsSec.classList.remove('disabled-opacity');
    currentModeBadge.innerText = 'POV Mode';
    helpText.innerText = '💡 Marmoset first-person POV. Drag sliders to adjust camera offset and angles.';
    
    // Disable Orbit Controls in POV mode
    controls.enabled = false;
    camera.fov = 120;
    camera.updateProjectionMatrix();
    
    if (eyeHelper) {
      eyeHelper.visible = false;
    }
  });

  // Target Eye Dropdown
  document.getElementById('select-eye').addEventListener('change', (e) => {
    povSettings.eyeTarget = e.target.value;
  });

  // Slider inputs mapping
  setupSlider('fov', 'slider-fov', 'val-fov', '°');
  setupSlider('offsetX', 'slider-offset-x', 'val-offset-x', '', 3);
  setupSlider('offsetY', 'slider-offset-y', 'val-offset-y', '', 3);
  setupSlider('offsetZ', 'slider-offset-z', 'val-offset-z', '', 3);
  setupSlider('pitch', 'slider-pitch', 'val-pitch', '°');
  setupSlider('yaw', 'slider-yaw', 'val-yaw', '°');
  setupSlider('roll', 'slider-roll', 'val-roll', '°');
  setupSlider('speed', 'slider-speed', 'val-speed', 'x', 1);

  // Custom Speed Slider Action
  document.getElementById('slider-speed').addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    if (mixer) mixer.timeScale = value;
  });

  // Reset Calibration Button
  document.getElementById('btn-reset-calibration').addEventListener('click', () => {
    resetCalibration();
  });

  // Play / Pause Animation
  const btnPlayPause = document.getElementById('btn-play-pause');
  btnPlayPause.addEventListener('click', () => {
    if (!activeAction) return;
    if (activeAction.paused) {
      activeAction.paused = false;
      btnPlayPause.innerText = 'Pause';
      btnPlayPause.classList.remove('btn-secondary');
      btnPlayPause.classList.add('btn-primary');
    } else {
      activeAction.paused = true;
      btnPlayPause.innerText = 'Play';
      btnPlayPause.classList.remove('btn-primary');
      btnPlayPause.classList.add('btn-secondary');
    }
  });

  // Animation Timeline Seeker
  const sliderTimeline = document.getElementById('slider-timeline');
  sliderTimeline.addEventListener('mousedown', () => { isUserDraggingTimeline = true; });
  sliderTimeline.addEventListener('touchstart', () => { isUserDraggingTimeline = true; });
  
  sliderTimeline.addEventListener('input', (e) => {
    if (!activeAction) return;
    const clip = activeAction.getClip();
    const duration = clip.duration;
    const percent = parseFloat(e.target.value);
    
    const targetTime = (percent / 100) * duration;
    mixer.setTime(targetTime);
    
    document.getElementById('time-current').innerText = targetTime.toFixed(1) + 's';
  });

  const stopDragTimeline = () => { isUserDraggingTimeline = false; };
  sliderTimeline.addEventListener('mouseup', stopDragTimeline);
  sliderTimeline.addEventListener('touchend', stopDragTimeline);

  // Checkboxes
  document.getElementById('check-bones').addEventListener('change', (e) => {
    if (skeletonHelper) skeletonHelper.visible = e.target.checked;
  });

  document.getElementById('check-eye-helper').addEventListener('change', (e) => {
    if (eyeHelper) {
      eyeHelper.visible = e.target.checked && cameraMode === 'orbit';
    }
  });

  document.getElementById('check-grid').addEventListener('change', (e) => {
    gridHelper.visible = e.target.checked;
  });

  // Lighting Select
  document.getElementById('select-lighting').addEventListener('change', (e) => {
    povSettings.lighting = e.target.value;
    setLightingPreset(e.target.value);
  });

  // Web Camera toggle button
  const btnWebcam = document.getElementById('btn-webcam');
  if (btnWebcam) {
    btnWebcam.addEventListener('click', () => {
      toggleWebcam();
    });
  }
}

// Slider helper
function setupSlider(key, sliderId, displayId, suffix = '', decimals = 0) {
  const slider = document.getElementById(sliderId);
  const display = document.getElementById(displayId);

  slider.addEventListener('input', (e) => {
    let value = parseFloat(e.target.value);
    povSettings[key] = value;
    display.innerText = value.toFixed(decimals) + suffix;
    
    // If it's FOV slider, update camera projection matrix immediately if in POV
    if (key === 'fov') {
      camera.fov = value;
      camera.updateProjectionMatrix();
    }
  });
}

// Reset Calibration values
function resetCalibration() {
  povSettings = { ...defaults };
  
  // Update inputs values
  document.getElementById('select-eye').value = defaults.eyeTarget;
  document.getElementById('slider-fov').value = defaults.fov;
  document.getElementById('val-fov').innerText = defaults.fov + '°';
  
  document.getElementById('slider-offset-x').value = defaults.offsetX;
  document.getElementById('val-offset-x').innerText = defaults.offsetX.toFixed(3);
  
  document.getElementById('slider-offset-y').value = defaults.offsetY;
  document.getElementById('val-offset-y').innerText = defaults.offsetY.toFixed(3);

  document.getElementById('slider-offset-z').value = defaults.offsetZ;
  document.getElementById('val-offset-z').innerText = defaults.offsetZ.toFixed(3);

  document.getElementById('slider-pitch').value = defaults.pitch;
  document.getElementById('val-pitch').innerText = defaults.pitch + '°';

  document.getElementById('slider-yaw').value = defaults.yaw;
  document.getElementById('val-yaw').innerText = defaults.yaw + '°';

  document.getElementById('slider-roll').value = defaults.roll;
  document.getElementById('val-roll').innerText = defaults.roll + '°';

  document.getElementById('slider-speed').value = defaults.speed;
  document.getElementById('val-speed').innerText = defaults.speed.toFixed(1) + 'x';

  document.getElementById('select-lighting').value = defaults.lighting;
  setLightingPreset(defaults.lighting);

  if (mixer) mixer.timeScale = defaults.speed;
  camera.fov = cameraMode === 'pov' ? 120 : 45;
  camera.updateProjectionMatrix();
}

// --- Window Resize ---
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Toggle Skinned Meshes (Marmoset Body Parts) Visibility ---
function setMarmosetVisibility(visible) {
  if (!model) return;
  model.traverse((child) => {
    if (child.isSkinnedMesh) {
      child.visible = visible;
    }
  });
}

// --- Core Render / Update Loop ---
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // 1. Update Skeletal Animation
  if (mixer && !isUserDraggingTimeline && activeAction) {
    if (lastReceivedSyncTime !== null) {
      let targetTime = lastReceivedSyncTime;
      if (!isParentPaused) {
        const elapsedSinceSync = (performance.now() - lastReceivedSyncTimestamp) / 1000;
        targetTime += elapsedSinceSync;
      }
      
      mixer.setTime(targetTime);
      
      // Update timeline position slider
      const clip = activeAction.getClip();
      const duration = clip.duration;
      const displayTime = targetTime % duration;
      
      document.getElementById('time-current').innerText = displayTime.toFixed(1) + 's';
      
      const pct = (displayTime / duration) * 100;
      document.getElementById('slider-timeline').value = pct;
    } else if (!activeAction.paused) {
      mixer.update(delta);
      
      // Update timeline position slider
      const clip = activeAction.getClip();
      const currentTime = activeAction.time;
      const duration = clip.duration;
      
      document.getElementById('time-current').innerText = currentTime.toFixed(1) + 's';
      
      const pct = (currentTime / duration) * 100;
      document.getElementById('slider-timeline').value = pct;
    }
  }

  // 2. Perform POV Tracking or Orbit Rendering
  scene.updateMatrixWorld(true);

  if (cameraMode === 'pov') {
    trackMarmosetPOV();
    // Hide body in POV mode if checked
    const hideBody = document.getElementById('check-hide-body').checked;
    setMarmosetVisibility(!hideBody);
  } else {
    // Normal third person mode: always show body
    setMarmosetVisibility(true);

    // Track marmoset in orbit if checked
    const trackMarmoset = document.getElementById('check-track-marmoset').checked;
    if (trackMarmoset && (headBone || eyeL)) {
      const targetNode = headBone || eyeL;
      targetNode.updateMatrixWorld(true);
      const tempTarget = new THREE.Vector3();
      targetNode.getWorldPosition(tempTarget);
      controls.target.copy(tempTarget);
    }

    controls.update();
    
    // Update Gaze visualizer cone position and rotation in real-time
    updateEyeHelperTransform();
  }

  // 3. Render Scene
  renderer.render(scene, camera);
}

// --- Update Eye Gaze Cone position & rotation (Orbit mode) ---
function updateEyeHelperTransform() {
  if (!eyeHelper || !eyeHelper.visible) return;

  const posL = new THREE.Vector3();
  const posR = new THREE.Vector3();
  const eyeMidpoint = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();

  if (eyeL && eyeR) {
    // Obtain absolute world positions of Left & Right Eye bones
    eyeL.updateMatrixWorld(true);
    eyeR.updateMatrixWorld(true);
    
    eyeL.getWorldPosition(posL);
    eyeR.getWorldPosition(posR);
    
    // Place helper in between eyes
    eyeMidpoint.addVectors(posL, posR).multiplyScalar(0.5);
    eyeHelper.position.copy(eyeMidpoint);

    // Track rotation using the head bone rotation
    if (headBone) {
      headBone.updateMatrixWorld(true);
      headBone.getWorldQuaternion(worldQuat);
    } else {
      eyeL.getWorldQuaternion(worldQuat);
    }
  } else if (headBone) {
    // Fallback to Head bone position if eyes are not loaded yet
    headBone.updateMatrixWorld(true);
    headBone.getWorldPosition(eyeMidpoint);
    headBone.getWorldQuaternion(worldQuat);

    eyeHelper.position.copy(eyeMidpoint);
  } else {
    return;
  }

  // Calculate POV camera orientation (gaze direction)
  const alignmentQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const calibrationQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(povSettings.pitch),
      THREE.MathUtils.degToRad(povSettings.yaw),
      THREE.MathUtils.degToRad(povSettings.roll),
      'YXZ'
    )
  );

  const gazeQuat = worldQuat.clone().multiply(alignmentQuat).multiply(calibrationQuat);
  
  // Helper geometry points along +Y, so rotate +90 degrees around X to align with camera -Z look direction
  const geomAdj = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  eyeHelper.quaternion.copy(gazeQuat).multiply(geomAdj);
}

// --- Dynamic Bone Tracking & Camera Attachment (POV Mode) ---
function trackMarmosetPOV() {
  const worldPos = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();

  // 1. Compute World Position based on target selection
  if (povSettings.eyeTarget === 'left' && eyeL) {
    eyeL.updateMatrixWorld(true);
    eyeL.getWorldPosition(worldPos);
    eyeL.getWorldQuaternion(worldQuat);
  } else if (povSettings.eyeTarget === 'right' && eyeR) {
    eyeR.updateMatrixWorld(true);
    eyeR.getWorldPosition(worldPos);
    eyeR.getWorldQuaternion(worldQuat);
  } else {
    // Center eye position (midpoint of Eye.L and Eye.R)
    if (eyeL && eyeR) {
      eyeL.updateMatrixWorld(true);
      eyeR.updateMatrixWorld(true);

      const posL = new THREE.Vector3();
      const posR = new THREE.Vector3();
      eyeL.getWorldPosition(posL);
      eyeR.getWorldPosition(posR);

      worldPos.addVectors(posL, posR).multiplyScalar(0.5);
      
      // Use head rotation for stability
      if (headBone) {
        headBone.updateMatrixWorld(true);
        headBone.getWorldQuaternion(worldQuat);
      } else {
        eyeL.getWorldQuaternion(worldQuat);
      }
    } else if (headBone) {
      // Fallback if eyes are missing
      headBone.updateMatrixWorld(true);
      headBone.getWorldPosition(worldPos);
      headBone.getWorldQuaternion(worldQuat);
    }
  }

  // 2. Compute final camera orientation (aligned to look along local Y of Head/Eye)
  const alignmentQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const calibrationQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(povSettings.pitch),
      THREE.MathUtils.degToRad(povSettings.yaw),
      THREE.MathUtils.degToRad(povSettings.roll),
      'YXZ'
    )
  );

  const gazeQuat = worldQuat.clone().multiply(alignmentQuat).multiply(calibrationQuat);
  camera.quaternion.copy(gazeQuat);

  // 3. Apply Position Offsets relative to the camera's view orientation:
  // - X offset is Right/Left
  // - Y offset is Up/Down
  // - Z offset is Forward/Backward (moving along camera -Z axis)
  const localOffset = new THREE.Vector3(
    povSettings.offsetX,
    povSettings.offsetY,
    -povSettings.offsetZ
  );
  localOffset.applyQuaternion(camera.quaternion);
  
  // Position the camera
  camera.position.copy(worldPos).add(localOffset);
}

// --- Web Camera Functions ---

function toggleWebcam() {
  const btn = document.getElementById('btn-webcam');
  if (webcamStream) {
    stopWebcam();
    if (btn) {
      btn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: currentColor;">
          <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM14 16H5V8h9v8z"/>
        </svg>
        <span>Start Web Camera</span>
      `;
      btn.classList.remove('active');
    }
  } else {
    startWebcam().then(success => {
      if (success && btn) {
        btn.innerHTML = `
          <svg class="icon" viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: currentColor;">
            <path d="M18 11.03V7c0-.55-.45-1-1-1H5c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-4.03l5 4.95V6.08l-5 4.95zM16 16H6V8h10v8z"/>
          </svg>
          <span>Stop Web Camera</span>
        `;
        btn.classList.add('active');
      }
    });
  }
}

async function startWebcam() {
  try {
    if (!webcamVideoElement) {
      webcamVideoElement = document.createElement('video');
      webcamVideoElement.autoplay = true;
      webcamVideoElement.playsInline = true;
      webcamVideoElement.muted = true;
      webcamVideoElement.style.display = 'none';
      document.body.appendChild(webcamVideoElement);
    }

    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
    } catch (e) {
      console.warn("High-resolution camera access failed, falling back to standard video constraints:", e);
      // Fallback: try requesting any video source without strict resolution settings
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: true
      });
    }
    webcamVideoElement.srcObject = webcamStream;
    await webcamVideoElement.play();

    webcamTexture = new THREE.VideoTexture(webcamVideoElement);
    webcamTexture.colorSpace = THREE.SRGBColorSpace;
    webcamTexture.minFilter = THREE.LinearFilter;
    webcamTexture.magFilter = THREE.LinearFilter;
    webcamTexture.generateMipmaps = false;

    if (!virtualMonitorGroup) {
      virtualMonitorGroup = create3DMonitor(webcamTexture);
    } else {
      virtualMonitorGroup.traverse((child) => {
        if (child.name === 'monitorScreen') {
          child.material.map = webcamTexture;
          child.material.needsUpdate = true;
        }
      });
    }

    scene.add(virtualMonitorGroup);
    console.log('Webcam started and 3D monitors added to scene.');
    return true;
  } catch (error) {
    console.error('Error starting webcam:', error);
    alert('Web camera access failed: ' + error.message);
    return false;
  }
}

function stopWebcam() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
  }
  if (webcamVideoElement) {
    webcamVideoElement.srcObject = null;
  }
  if (virtualMonitorGroup) {
    scene.remove(virtualMonitorGroup);
  }
  if (webcamTexture) {
    webcamTexture.dispose();
    webcamTexture = null;
  }
  console.log('Webcam stopped and 3D monitors removed.');
}

function create3DMonitor(texture) {
  const group = new THREE.Group();
  group.name = 'virtualMonitorGroup';

  // Common bezel material
  const bezelMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a, // Dark slate gray
    roughness: 0.2,
    metalness: 0.8,
    transparent: true,
    opacity: 0.85
  });

  // Large Screen (3x Size of the original monitor)
  const screenGeom = new THREE.PlaneGeometry(0.48 * 3.0, 0.27 * 3.0);
  const screenMat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    toneMapped: false // Keep colors bright and un-tonemapped
  });
  const screenMesh = new THREE.Mesh(screenGeom, screenMat);
  screenMesh.name = 'monitorScreen';
  group.add(screenMesh);

  // Large Bezel
  const bezelGeom = new THREE.BoxGeometry(0.50 * 3.0, 0.29 * 3.0, 0.012 * 3.0);
  const bezelMesh = new THREE.Mesh(bezelGeom, bezelMat);
  bezelMesh.position.z = -0.024; // Offset just behind the screen plane
  group.add(bezelMesh);

  // Position the monitor at the back of the cage (+X), directly in front of the back camera
  if (controls && controls.target) {
    group.position.set(
      controls.target.x + 0.85, // Shift further back (+X)
      controls.target.y + 0.25, // Elevated (+Y)
      controls.target.z
    );
  } else {
    group.position.set(0.85, 1.10, 0.11);
  }

  // Rotate Y by -Math.PI / 2 so the screen faces towards the inside of the cage (-X direction)
  group.rotation.y = -Math.PI / 2;

  return group;
}

// Initialize!
init();
