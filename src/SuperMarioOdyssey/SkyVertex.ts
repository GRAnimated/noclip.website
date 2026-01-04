export function generateSkyVertexShader(): string {
    return `
layout(location = 0) in vec3 _p0;
layout(location = 1) in vec4 _c0;
layout(location = 2) in vec2 _u0;
layout(location = 3) in vec4 _n0;
layout(location = 4) in vec4 _t0;

out vec3 v_Normal;
out float v_Depth;
out vec4 v_Tangents;
out vec4 v_Bitangents;
out vec4 v_ViewPos;
out vec4 v_LightColorVPosZ;
out vec2 v_TexCoord0;
out vec2 v_TexCoord1;
out vec2 v_TexCoord2;
out vec2 v_TexCoord3;
out vec4 v_VtxColor;
out vec4 v_IrradianceVertex;
out vec2 v_SphereCoords;
out vec4 v_PerspDiv;

void main() {
    vec3 t_PositionView = UnpackMatrix(u_ModelView) * vec4(_p0, 1.0);
    gl_Position = UnpackMatrix(u_Projection) * vec4(t_PositionView, 1.0);

    vec4 view_pos = multMtx34Vec4(mdlEnvView.cView, vec4(_p0, 1.0));
    v_ViewPos.zw = view_pos.xy;
    v_LightColorVPosZ.w = view_pos.z;

    // Calculate light color
    vec3 light_color = vec3(1.0); // TEMP
    
    // vec3 light_color = textureLod(cDirectionalLightColor, vec2(mdlEnvView.cDirLightViewDirFetchPos.w, 0.5), 0.0).xyz;
    
    v_LightColorVPosZ.xyz = light_color;

    const float MAX_LOD = 5.0;
    // vec4 irradiance_cubemap = DecodeCubemap(cTexCubeMapRoughness, v_Normal, MAX_LOD);
    // v_IrradianceVertex.rgba = irradiance_cubemap.rgba * mdlEnvView.uIrradianceScale;
    
    // TEMP: using vertex color as irradiance
    v_IrradianceVertex = _c0;

    // Sphere mapping coordinates
    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, v_Normal));
    v_SphereCoords = view_normal.xy * 0.5 + 0.5;

    v_PerspDiv.xy = gl_Position.xy / gl_Position.w;

    v_TexCoord0 = _u0;
    v_VtxColor = _c0;
    v_Normal = _n0.xyz;
    v_Tangents = _t0;
    
    // bitangent
    vec3 B = normalize(cross(v_Normal, _t0.xyz) * _t0.w);
    v_Tangents.w = B.x;
    v_Bitangents.x = B.y;
    v_Bitangents.y = B.z;
}

`;
}
