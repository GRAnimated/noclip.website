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

// Shader code adapted from learnopengl.com's PBR tutorial:
// https://learnopengl.com/PBR/Theory

vec3 FresnelSchlick(float cosTheta, vec3 F0)
{
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

vec3 FresnelSchlickRoughness(float cosTheta, vec3 F0, float roughness)
{
    return F0 + (max(vec3(1.0 - roughness), F0) - F0) * pow(1.0 - cosTheta, 5.0);
}

float DistributionGGX(vec3 N, vec3 H, float roughness)
{
    float a      = roughness*roughness;
    float a2     = a*a;
    float NdotH  = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;

    float num   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;

    return num / denom;
}

vec3 calcSpecularGGX(float roughness, vec3 f0, vec3 N, vec3 V, vec3 L, vec3 H)
{
	float N_H = saturate(dot(N, H));
	float L_H = saturate(dot(L, H));
	float N_V = saturate(dot(N, V));
	float N_L = saturate(dot(N, L));

    float D = DistributionGGX(N, H, roughness);
    vec3 kS = FresnelSchlick(max(dot(N, H), 0.0), f0);

	return f0 * kS * (N_L * D);
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

    mat3 tbn_matrix = mat3(T, B, N);

    vec3 tangent_normal = N;
    if (${program.getShaderOptionBoolean('enable_normal')} == true)
    {
        tangent_normal = ReconstructNormal(normal_map);
    }
    return normalize(tbn_matrix * tangent_normal).xyz;
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

void main() {
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

    //base color refract type
    if (${program.getShaderOptionBoolean('enable_transparent')} == true){
        vec3 refract_amount = refract_rate * (vec3(1) - brdf);
        vec3 refract_color = ${program.genOutput('o_refract_color')}.rgb;

        /*

        if (has_transparent_tex && transparent_tex_type == TRANS_TEX_TYPE_DIFFUSE 
                                || transparent_tex_type == TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE) 
        {
            vec3 transparent_tex = GetTransparentTexOutput(o_transparent_tex, refract_bias_x, refract_bias_y).rgb;
            //refract
            vec3 refract_value = transparent_tex * refract_color * refract_amount;
            if (transparent_tex_type == TRANS_TEX_TYPE_DIFFUSE_IRRADIANCE) //apply irradiance
                refract_value *= irradiance.rgb;

            diffuseTerm.rgb += refract_value;
        }
        if (enable_transparent)
        {
            if  (transparent_type == TRANS_TYPE_IND_FBO || transparent_type == TRANS_TYPE_IND_FBO_DEPTH)
            {
                vec2 ind_coords = refract_eta * -N_I * view_normal.xy;

                //coordinates with refract view as indirect
                vec2 coords = GetScreenCoordinates() + ind_coords;
                //Depth influences refraction
                if (enable_indirect_dist_correct)
                {
                    //depth difference between our current depth and the previously sampled depth
                    float d = -abs(fNormalsDepth.w - texture(cTextureLinearDepth, coords).x) * mat.indirect_depth_scale;
                    d = saturate(1.0 - exp2(d));
                   coords = GetScreenCoordinates() + ind_coords * d;
                }
                //depth type 
                if (transparent_type == TRANS_TYPE_IND_FBO_DEPTH)
                {
                    //Only refract coords behind the current pixel, else keep coordinates normal
                    if (texture(cTextureLinearDepth, coords).x < fNormalsDepth.w) 
                        coords = GetScreenCoordinates();
                }
                vec4 fbo = texture(cFrameBufferTex, coords);
                diffuseTerm.rgb += refract_amount * fbo.rgb * refract_color.rgb;
            }
        }
        */

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
    }

    gl_FragColor = vec4(base_color.rgb, alpha);

    gl_FragColor.rgb = pow(gl_FragColor.rgb, vec3(1.0 / 2.2));
}
`;
}
