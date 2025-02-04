import TextureBuffer from './textureBuffer';
import {vec3, vec4} from 'gl-matrix';

export const MAX_LIGHTS_PER_CLUSTER = 500;

function clampClusterIndex(val, min, max)
{
  return Math.min(Math.max(val, min), max);
}

export default class BaseRenderer {
  constructor(xSlices, ySlices, zSlices) {
    // Create a texture to store cluster data. Each cluster stores the number of lights followed by the light indices
    this._clusterTexture = new TextureBuffer(xSlices * ySlices * zSlices, MAX_LIGHTS_PER_CLUSTER + 1);
    // 3D grid of size xSlices * ySlices * zSlices
    this._xSlices = xSlices;
    this._ySlices = ySlices;
    this._zSlices = zSlices;
    this._elementCount = xSlices * ySlices * zSlices;
    this._elementSize = Math.ceil((MAX_LIGHTS_PER_CLUSTER + 1.0) / 4.0);
  }

  updateClusters(camera, viewMatrix, scene, wireframe) {
    // TODO: Update the cluster texture with the count and indices of the lights in each cluster
    // This will take some time. The math is nontrivial...

    // Each x, y, z represents one cluster
    for (let z = 0; z < this._zSlices; ++z) {
      for (let y = 0; y < this._ySlices; ++y) {
        for (let x = 0; x < this._xSlices; ++x) {
          // 1D grid index
          let i = x + y * this._xSlices + z * this._xSlices * this._ySlices;
          // Reset the light count to 0 for every cluster
          this._clusterTexture.buffer[this._clusterTexture.bufferIndex(i, 0)] = 0;
        }
      }
    }

    // For each light, figure out which clusters it overlaps
    // For each cluster, add this light to its light count and light list
    for (let i = 0; i < scene.lights.length; ++i) {
      // STEP 1. Find light position and radius
      let lightPos = scene.lights[i].position;
      let lightRadius = scene.lights[i].radius;

      // STEP 2. Find bounding box (min and max) of light based on radius
      let bbMin = vec3.fromValues(lightPos[0] - lightRadius, lightPos[1] - lightRadius, lightPos[2] - lightRadius);
      let bbMax = vec3.fromValues(lightPos[0] + lightRadius, lightPos[1] + lightRadius, lightPos[2] + lightRadius);

      // STEP 3. Transform bounding box (min and max) into view space using viewMatrix
      let viewBBMin = vec3.create();
      let viewBBMax = vec3.create();
      vec3.transformMat4(viewBBMin, bbMin, viewMatrix);
      vec3.transformMat4(viewBBMax, bbMax, viewMatrix);

      // STEP 4. Find x, y, z lengths of sub-frustum to project AABB coordinates into clip space 
      let zNear = -1.0 * viewBBMin[2];
      let zFar = -1.0 * viewBBMax[2];
      let zStep = (camera.far - camera.near) / this._zSlices;
      let tanFov = Math.tan(0.5 * camera.fov * (Math.PI / 180.0));

      let halfYLenNear = zNear * tanFov;
      let halfXLenNear = halfYLenNear * camera.aspect;

      let halfYLenFar = zFar * tanFov;
      let halfXLenFar = halfYLenFar * camera.aspect;

      // STEP 5. Calculate min and max cluster indices (clamp to cull objects out of view)
      let xMin = Math.floor(viewBBMin[0] + (this._xSlices *  halfXLenNear) / (2.0 * halfXLenNear));
      let xMax = Math.ceil(viewBBMax[0] +  (this._xSlices * halfXLenFar) / (2.0 * halfXLenFar));
      
      // Uncomment these for alternate computation method (with artifacts)
      //let xMin = Math.floor((viewBBMin[0] + halfXLenNear) / (2.0 * halfXLenNear / this._xSlices));
      //let xMax = Math.ceil((viewBBMax[0] + halfXLenFar) / (2.0 * halfXLenFar / this._xSlices));
      
      xMin = clampClusterIndex(xMin, 0, this._xSlices);
      xMax = clampClusterIndex(xMax, 0, this._xSlices);

      // Swap min and max if necessary
      let tmp = Math.max(xMin, xMax);
      xMin = Math.min(xMin, xMax);
      xMax = tmp;

      let yMin = Math.floor(viewBBMin[1] + (this._ySlices * halfYLenNear) / (2.0 * halfYLenNear));
      let yMax = Math.ceil(viewBBMax[1] + (this._ySlices * halfYLenFar) / (2.0 * halfYLenFar));
      
      // Uncomment these for alternate computation method (with artifacts)
      //let yMin = Math.floor((viewBBMin[1] + halfYLenNear) / (2.0 * halfYLenNear / this._ySlices));
      //let yMax = Math.ceil((viewBBMax[1] + halfYLenFar) / (2.0 * halfYLenFar / this._ySlices));
      
      yMin = clampClusterIndex(yMin, 0, this._ySlices);
      yMax = clampClusterIndex(yMax, 0, this._ySlices);

      // Swap min and max if necessary
      tmp = Math.max(yMin, yMax);
      yMin = Math.min(yMin, yMax);
      yMax = tmp;

      let zMin = Math.floor(zNear / zStep);
      let zMax = Math.ceil(zFar / zStep);
      //console.log("z: ", zMin, zMax);
      zMin = clampClusterIndex(zMin, 0, this._zSlices);
      zMax = clampClusterIndex(zMax, 0, this._zSlices);

      // Swap min and max if necessary
      tmp = Math.max(zMin, zMax);
      zMin = Math.min(zMin, zMax);
      zMax = tmp;

      // STEP 6. Iterate over min and max x, y, z frustum coordinates and add light to light count and light indices
      // Add this information to the clusterTexture - first index will be light count, the following indices will be the lights
      // Each cluster has ceil(lightsSize / 4) pixels, where each pixel holds 4 float values
      for (let z = zMin; z < zMax; ++z) {
        for (let y = yMin; y < yMax; ++y) {
          for (let x = xMin; x < xMax; ++x) {
            // Current cluster's 1D index
            let clusterIdx = x + y * this._xSlices + z * this._xSlices * this._ySlices;

            // Texture index where lightsCount is stored
            let lightCountIdx = this._clusterTexture.bufferIndex(clusterIdx, 0);

            if (this._clusterTexture.buffer[lightCountIdx] < MAX_LIGHTS_PER_CLUSTER) {
              // Increment light count
              this._clusterTexture.buffer[lightCountIdx] += 1;
              let lightIdx = this._clusterTexture.buffer[lightCountIdx];

              // Add light (with index i) to cluster's list of lights
              let pixelNum = Math.floor(lightIdx / 4);
              let pixelComponent = Math.floor(lightIdx % 4);
              this._clusterTexture.buffer[this._clusterTexture.bufferIndex(clusterIdx, pixelNum) + pixelComponent] = i;
            }
          }
        }
      }
    }

    this._clusterTexture.update();
  }
}