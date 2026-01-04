export function generateSkyVertexShader(): string {
    return `
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;

out vec2 v_TexCoord0;

void main() {
    vec3 viewPos = multMtx34Vec3(u_ModelView, _p0);
    vec4 clip = multMtx44Vec3(u_Projection, viewPos);

    gl_Position = vec4(clip.xy, clip.z, clip.w);
    
    v_TexCoord0 = _u0;
}
`;
}
