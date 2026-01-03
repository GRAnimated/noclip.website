import { AglProgram } from './Render.js';

export function generateFragmentShader(program: AglProgram): string {
    return `
precision mediump float;

in vec3 v_Normal;
in float v_Depth;
in vec4 v_Tangents;
in vec4 v_Bitangents;
in vec4 v_ViewPos;
in vec4 v_LightColorVPosZ;
in vec2 v_TexCoord0;
in vec2 v_TexCoord1;
in vec2 v_TexCoord2;
in vec2 v_TexCoord3;
in vec4 v_VtxColor;
in vec4 v_IrradianceVertex;
in vec2 v_SphereCoords;
in vec4 v_PerspDiv;

vec3 GetWorldNormal() {
    return normalize(v_Normal);
}

vec3 GetWorldBitangent() {
    return normalize(vec3(v_Tangents.w, v_Bitangents.xy));
}

vec3 GetWorldTangent() {
    return normalize(v_Tangents.xyz);
}

vec3 calcSpecularGGX(float roughness, vec3 f0, vec3 N, vec3 V, vec3 L, vec3 H)
{
	float N_H = saturate(dot(N, H));
	float L_H = saturate(dot(L, H));
	float N_V = saturate(dot(N, V));
	float N_L = saturate(dot(N, L));

    // Distribution term (D)
    float alpha = roughness * roughness;
    float alpha_2 = alpha * alpha;
    float denom = N_H * N_H * (alpha_2 - 1.0) + 1.0;
    float pi_denom_2 = PI * denom * denom;
    float D = alpha_2 / max(pi_denom_2, 0.0005);

    // Fresnel term (F)
    float dotLH5 = pow(1.0 - L_H, 5.0);
    float F_a = 1.0;
    float F_b = dotLH5;
    
    // Visibility/Geometry term (V)
    float k = alpha * 0.5;
    float k2 = k * k;
    float invK2 = 1.0 - k2;
    float vis_numerator = abs(N_V) * N_L;
    float vis = vis_numerator / (L_H * L_H * invK2 + k2);
    
    // Combine F and V
    vec2 FV_helper;
    FV_helper.x = (F_a - F_b) * vis;
    FV_helper.y = F_b * vis;
    vec3 FV = f0 * FV_helper.x + FV_helper.y;
    
    // Final specular with cavity coefficient approximation
    float spc_cavity_coef = mix(1.0 - roughness * roughness, 1.0, 0.0) * 0.5; // metalness would go here
    return FV * (N_L * D * spc_cavity_coef);
}

vec3 ReconstructNormal(in vec2 t_NormalXY) {
    float t_NormalZ = sqrt(clamp(1.0 - dot(t_NormalXY.xy, t_NormalXY.xy), 0.0, 1.0));
    return vec3(t_NormalXY.xy, t_NormalZ);
}

vec3 CalculateNormals(vec3 normals, vec2 normal_map)
{
    if (${program.getShaderOptionBoolean('enable_normal')} == false)
        return normals;

    vec3 N = vec3(normals);
    vec3 T = vec3(v_Tangents.xyz);
    vec3 B = vec3(v_Tangents.w, v_Bitangents.xy);

    // mat3 tbn_matrix = mat3(T, B, N);

    vec3 tangent_normal = N;
    if (${program.getShaderOptionBoolean('enable_normal')} == true)
    {
        tangent_normal = ReconstructNormal(normal_map);
    }
    // tbn_matrix multiplication
    vec3 world_normal = normalize(
        tangent_normal.x * T +
        tangent_normal.y * B +
        tangent_normal.z * N
    );
    return world_normal;
}

float CalculateSphereLight() {
    vec3 vertex_normal = normalize(v_Normal);
    if (${program.getShaderOptionBoolean('is_use_back_face_lighting')} == true)
        vertex_normal = 1.0 - vertex_normal;

    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, vertex_normal.xyz));
    vec3 view_pos = vec3(v_ViewPos.zw, v_LightColorVPosZ.w);

    vec3 dir = normalize(view_pos);

    return clamp(fma(dir.z, -view_normal.z,
                    fma(dir.x, -view_normal.x, 
                    dir.y * -view_normal.y)), 0.0, 1.0);
}

vec4 CalculateSphereConstColor(int sphere_color_type, vec4 const_color, float sphere_rate_color) {
    float cosTheta  = CalculateSphereLight();

    if (sphere_color_type == 1) // inverted fresnel effect
    {
        float amount = clamp(exp2(log2(cosTheta) * sphere_rate_color), 0.0, 1.0);
        return const_color * amount;
    }
    else if (sphere_color_type == 2) // fresnel effect
    {
        float amount = clamp(exp2(log2(1.0 - cosTheta) * sphere_rate_color), 0.0, 1.0);
        return const_color * amount;
    }
    else
        return const_color; // type 0 defaults to const color
}

vec4 CALCULATE_CONST_COLOR(int sphere_color_type, vec4 const_color, float sphere_rate_color) {
    return CalculateSphereConstColor(sphere_color_type, const_color, sphere_rate_color);
}

vec4 CalculateCofBlendOutput(int flag, int cof_map) {
    if (flag == 10)      return v_VtxColor;
    // else if (flag == 20) return CalculateBlendOutput(cof_map); // cof_map

    else if (flag == 30) return vec4(mat.const_single0); // mat.const_single0
    else if (flag == 31) return vec4(mat.const_single1); // mat.const_single1
    else if (flag == 32) return vec4(mat.const_single2); // mat.const_single2
    else if (flag == 33) return vec4(mat.const_single3); // mat.const_single3

    else if (flag == 60) return CALCULATE_CONST_COLOR(${program.getShaderOptionNumber('sphere_const_color0')}, mat.const_color0, mat.sphere_rate_color0); // mat.const_color0
    else if (flag == 61) return CALCULATE_CONST_COLOR(${program.getShaderOptionNumber('sphere_const_color1')}, mat.const_color1, mat.sphere_rate_color1); // mat.const_color1
    else if (flag == 62) return CALCULATE_CONST_COLOR(${program.getShaderOptionNumber('sphere_const_color2')}, mat.const_color2, mat.sphere_rate_color2); // mat.const_color2
    else if (flag == 63) return CALCULATE_CONST_COLOR(${program.getShaderOptionNumber('sphere_const_color3')}, mat.const_color3, mat.sphere_rate_color3); // mat.const_color3

    else if (flag == 115) return vec4(0.0); // constant
    else if (flag == 116) return vec4(1.0); // constant

    return vec4(0.0);
}

vec3 CalculateEmissionScale(vec3 emission, int scale_type, vec4 irradiance)
{
    //Emission scale
    if      (scale_type == 1) // emission * irradiance, max by emission
        emission = max(irradiance.rgb * emission.rgb, emission.rgb);
    else if (scale_type == 2) // emission * irradiance, max by 1.0
        emission = emission * max(irradiance.rgb, 1.0);
    else if (scale_type == 3) // emission * irradiance color
        emission = emission * irradiance.rgb;
    else if (scale_type == 4) // emission * irradiance scale
        emission = emission * irradiance.w;
    else if (scale_type == 5) // max irradiance light amount
    {
        float max_scale = max(max(irradiance.g, irradiance.b), irradiance.r);
        emission = max_scale * emission;
    }
    else if (scale_type == 6) // max irradiance light amount maxed by emission amount
    {
        float max_scale = max(max(irradiance.g, irradiance.b), irradiance.r);
        emission = max(vec3(max_scale) * emission, emission);
    }
    else if (scale_type == 7) // exposure scale    
    {   
        // TODO: Need exposure texture 
        // float exposure = texture(cExposureTexture, vec2(0.0, 0.0)).a;
        // emission *= 1.0 / exposure * mdlEnvView.Exposure.x;
    }
    return emission;
}

vec3 CalculateEmission(vec4 irradiance)
{
    vec3 emission = vec3(0.0);

    if (${program.getShaderOptionBoolean('enable_emission')} == true)
    {
        emission = ${program.genOutput('o_emission')}${program.genOutputCompMask('emission_component')}.rgb;

        if (${program.getShaderOptionNumber('vtxcolor_type')} == 2) // VTX_COLOR_TYPE_EMISSION
            emission *= v_VtxColor.rgb;

        //Emission scale
        int emission_scale_type = ${program.getShaderOptionNumber('emission_scale_type')};
        emission = CalculateEmissionScale(emission, emission_scale_type, irradiance);
    }
    return emission;
}

struct Light
{
    vec3 I; // eye
    vec3 N; // normal
    vec3 V; // view
    vec3 H; // half
    vec3 L; // light
    vec3 R; // reflect
    float NV; // dot normal view
};

Light SetupLight(vec3 N, vec3 view_pos)
{
    Light light;

    vec3 dir = normalize(view_pos);
    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, N).xyz);
    vec3 cubemap_coords = multMtx34Vec3(mdlEnvView.cViewInv, reflect(dir, view_normal.rgb));

    light.N = N;
    light.I = multMtx34Vec3(mdlEnvView.cView, vec3(0,0,1));
    light.V = normalize(light.I); // view
    light.L = normalize(mdlEnvView.cDirLightViewDirFetchPos.xyz ); // light
    light.H = normalize(light.V + light.L); // half angle
    light.R = vec3(cubemap_coords.x, cubemap_coords.y, -cubemap_coords.z); // reflection
    light.NV = saturate(dot(light.N, light.V));

    return light;
}

vec4 CalculateDiffuseIrradianceLight(Light light)
{
    vec4 irradiance = vec4(0.0, 0.0, 0.0, 1.0);
    //Z seems flipped
    vec3 dir = vec3(light.N.x, light.N.y, -light.N.z);

    // irradiance lighting
    if (${program.getShaderOptionBoolean('is_apply_irradiance_pixel')} == true)
    {
        // TODO: Cubemap based irradiance
        /*
        if (${program.getShaderOptionBoolean('enable_material_light')} == true)
        {
            const float MAX_LOD = 5.0;
            vec4 irradiance_cubemap = DecodeCubemap(cTextureMaterialLightCube, dir, MAX_LOD);
            irradiance.rgba = irradiance_cubemap.rgba * mdlEnvView.Exposure.y;
        }
        else //use material roughness cubemap
        {
            const float MAX_LOD = 5.0;
            vec4 irradiance_cubemap = DecodeCubemap(cTexCubeMapRoughness, dir, MAX_LOD);
            irradiance.rgba = irradiance_cubemap.rgba * mdlEnvView.Exposure.y;
        }
        if (${program.getShaderOptionBoolean('enable_material_sphere_light')} == true)
        {
	        vec2 sphereCoords = light.N.xy * vec2(0.5) + vec2(0.5,0.5);
            vec4 sphere_light = textureLod(cTextureMaterialLightSphere, sphereCoords, 1.0).xyzw;
            irradiance.rgba += sphere_light.rgba * mdlEnvView.Exposure.y;
        }
        */

        // TEMP
        irradiance.rgb = vec3(0.05);
    }
    else //calculated per vertex
    {
        //By vertex color
        // if (vtxcolor_type == VTX_COLOR_TYPE_IRRADIANCE) {
        irradiance.rgba = v_VtxColor;
        // } else { //Calculated in vertex shader
        //     irradiance.rgba = fIrradianceVertex.rgba;
        // }
    }
    return irradiance;
}

vec3 CalculateBrdf(vec3 view_normal, vec3 dir, float roughness, vec3 f0)
{
    float r = (1.0 - roughness);
    float a = r * r;
    float a2 = a * a;

    float nv = dot(view_normal, -dir);

    float s = clamp(min(a2 * fma(a2, 1.895, -0.1688), 
        fma(nv, fma(nv, fma(nv, -5.069, 8.404), -4.853), 0.9903)) + 0.0, 0.0, 1.0);

    float b = clamp(fma(nv, fma(nv, 0.1939, -0.5228), a2 *
        (fma(a2, fma(a2, 2.661, -3.603), nv * 1.404) + 1.699)) + 0.6045, 0.0, 1.0) - s;

    return f0.rgb * b + s * saturate(f0.g * 50.0);
}

vec2 GetScreenCoordinates()
{
	vec2 screenCoord = v_PerspDiv.xy * 0.5 + 0.5;
    screenCoord.y = 1.0 - screenCoord.y;
    return screenCoord;
}

vec4 BLEND0_OUTPUT;
vec4 BLEND1_OUTPUT;
vec4 BLEND2_OUTPUT;
vec4 BLEND3_OUTPUT;
vec4 BLEND4_OUTPUT;
vec4 BLEND5_OUTPUT;

void main() {
    BLEND0_OUTPUT = ${program.genBlend(0)};
    BLEND1_OUTPUT = ${program.genBlend(1)};
    BLEND2_OUTPUT = ${program.genBlend(2)};
    BLEND3_OUTPUT = ${program.genBlend(3)};
    BLEND4_OUTPUT = ${program.genBlend(4)};
    BLEND5_OUTPUT = ${program.genBlend(5)};
    
    vec4 base_color           = ${program.genOutput('o_base_color')};
    vec2 normal_map           = ${program.genOutput('o_normal')}.rg;
    float metalness   = ${program.genOutput('o_metalness')}${program.genOutputCompMask('metalness_component')}.r;
    float roughness   = ${program.genOutput('o_roughness')}${program.genOutputCompMask('roughness_component')}.r;
    vec4 sss                  = ${program.genOutput('o_sss')};
    vec4 ao                   = ${program.genOutput('o_ao')};
    float alpha      = ${program.genOutput('o_alpha')}${program.genOutputCompMask('alpha_component')}.r;
    bool has_transparent_tex = ${program.getShaderOptionBoolean('enable_transparent')};

    vec3 eye_to_pos = vec3(v_ViewPos.zw, v_LightColorVPosZ.w);
    vec3 dir = normalize(eye_to_pos);

    vec3 specularTerm = vec3(0.0);
    vec3 light_color = v_LightColorVPosZ.xyz;

    // View tangents
    vec3 view_tangent = vec3(1, 0, 0);
    vec3 view_bitangent = vec3(1, 0, 1);
    // if (o_normal != 30) //has tangents used // TEMP
    if (true) {
        vec3 tangent = vec3(v_Tangents.xyz);
        vec3 bitangent = vec3(v_Tangents.w, v_Bitangents.xy);

        view_tangent = multMtx34Vec3(mdlEnvView.cView, tangent);
        view_bitangent = multMtx34Vec3(mdlEnvView.cView, bitangent);
    }

    vec3 vertex_normal = v_Normal;

    vec3 N = CalculateNormals(v_Normal, normal_map);
    N.x *= modelInfo.normal_axis_x_scale;

    vec3 view_normal = normalize(multMtx34Vec3(mdlEnvView.cView, N).xyz);

    //Normal to eye
    float N_I = clamp(fma(view_normal.z, -dir.z,
        fma(view_normal.x,  -dir.x, 
            view_normal.y * -dir.y)), 0.0, 1.0);

    // TODO: Dirt stain

    float refract_eta = ${program.genOutput('o_refract_eta')}${program.genOutputCompMask('refract_eta_component')}.r;
    float refract_rate = ${program.genOutput('o_refract_rate')}${program.genOutputCompMask('refract_rate_component')}.r;

    vec3 refract_view =  refract_eta * -N_I * view_normal + dir * mat.refract_thickness; 

    //refract bias
    float refract_bias_x = dot(refract_view, view_tangent);
    float refract_bias_y = -dot(refract_view, view_bitangent);

    // TODO: Cloth

    if (${program.getShaderOptionBoolean('enable_ao')} == true)
        base_color.rgb *= ao.rgb;

    // TODO: Transparency

    // Lighting
    Light light = SetupLight(N, eye_to_pos);

    // Apply refract rate and reduce diffuse
    base_color.rgb *= vec3(1) - refract_rate;

    // Fresnel
    vec3 f0 = mix(vec3(0.04), base_color.rgb, metalness); // dialectric
    vec3 brdf = CalculateBrdf(view_normal, dir, roughness, f0);

    // Specular GGX
    if (${program.getShaderOptionBoolean('is_use_forward_ggx_specular')} == true)
    {
        vec3 spec_intensity = calcSpecularGGX(roughness, f0, light.N, light.V, light.L, light.H);
        specularTerm += spec_intensity;
    }

    // TODO: Cubemap

    // TODO: enable_structural_color

    // TODO: enable_material_sphere_light

    // Diffuse
    vec3 diffuseTerm = saturate(base_color.rgb);

    // Irradiance lighting
    vec4 irradiance = CalculateDiffuseIrradianceLight(light);

    // Adjust for metalness
    diffuseTerm *= saturate(1.0 - metalness);
    diffuseTerm *= vec3(1) - brdf;

    diffuseTerm *= irradiance.rgb;

    // Directional light
    float directionalLight = saturate(dot(N, mdlEnvView.cDirLightViewDirFetchPos.xyz)) * INV_PI;
    diffuseTerm += base_color.rgb * saturate(1.0 - metalness) * directionalLight * light_color;

    // Base color refract type
    if (${program.getShaderOptionBoolean('enable_transparent')} == true){
        vec3 refract_amount = refract_rate * (vec3(1) - brdf);
        vec3 refract_color = ${program.genOutput('o_refract_color')}.rgb;

        int transparent_tex_type = ${program.getShaderOptionNumber('transparent_tex_type')};
        
        // TRANS_TEX_TYPE_DIFFUSE || TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE
        if (has_transparent_tex && (transparent_tex_type == 15 || transparent_tex_type == 20))
        {
            // TODO: Need GetTransparentTexOutput function
            // vec3 transparent_tex = GetTransparentTexOutput(${program.genOutput('o_transparent_tex')}, refract_bias_x, refract_bias_y).rgb;
            // vec3 refract_value = transparent_tex * refract_color * refract_amount;
            // if (transparent_tex_type == 20) // TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE
            //     refract_value *= irradiance.rgb;
            // diffuseTerm.rgb += refract_value;
        }
        
        int transparent_type = ${program.getShaderOptionNumber('transparent_type')};
        
        // TRANS_TYPE_IND_FBO || TRANS_TYPE_IND_FBO_DEPTH
        if (transparent_type == 20 || transparent_type == 25)
        {
            vec2 ind_coords = refract_eta * -N_I * view_normal.xy;
            
            vec2 coords = GetScreenCoordinates() + ind_coords;
            
            // if (${program.getShaderOptionBoolean('enable_indirect_dist_correct')} == true)
            // {
            //     // TODO: Need cTextureLinearDepth
            //     // float d = -abs(v_Normal.w - texture(cTextureLinearDepth, coords).x) * mat.indirect_depth_scale;
            //     // d = saturate(1.0 - exp2(d));
            //     // coords = GetScreenCoordinates() + ind_coords * d;
            // }
            
            // if (transparent_type == 25) // TRANS_TYPE_IND_FBO_DEPTH
            // {
            //     // TODO: Need cTextureLinearDepth
            //     // if (texture(cTextureLinearDepth, coords).x < v_Normal.w) 
            //     //     coords = GetScreenCoordinates();
            // }
            
            // TODO: Need cFrameBufferTex
            // vec4 fbo = texture(cFrameBufferTex, coords);
            // diffuseTerm.rgb += refract_amount * fbo.rgb * refract_color.rgb;
        }
    }

    if (${program.getShaderOptionBoolean('enable_alphamask')} == true) {
        int alpha_test_func = ${program.getShaderOptionNumber('alpha_test_func')};
        if (alpha_test_func == 0) {
            discard;
        }
        else if (alpha_test_func == 10) {
            if (alpha >= mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 20) {
            if (alpha != mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 30) {
            if (alpha > mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 40) {
            if (alpha <= mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 50) {
            if (alpha == mat.alpha_test_value)
                discard;
        }
        else if (alpha_test_func == 60) {
            if (alpha < mat.alpha_test_value)
                discard;
        }
    }

    vec4 light_buf = vec4(0.0);

    // Light output diffuse + specular
    light_buf.rgb = diffuseTerm + specularTerm;
    light_buf.a = alpha;

    // TODO: Cloth Emission

    // Emission
    if (${program.getShaderOptionBoolean('enable_emission')} == true)
        light_buf.rgb += CalculateEmission(irradiance).rgb;
    
    // TODO: metal flake emission

    // TODO: SSS

    // TODO: if enable_translucent, adjust for shadows

    // clamp 0 - 2048 due to HDR/tone mapping
    light_buf.rgb = max(light_buf.rgb, 0.0);
    light_buf.rgb = min(light_buf.rgb, 2048.0);

    gl_FragColor = vec4(light_buf.rgb, light_buf.a);

    gl_FragColor.rgb = pow(gl_FragColor.rgb, vec3(1.0 / 2.2));
}
`;
}
