import { OdysseyProgram } from '../OdysseyProgram.js';

export function generateFogCode(): string {
    return `
vec3 CalculateFog(vec3 color, vec3 view_pos) {
    float fog_intensity = 0.0;
    float y_fog_intensity = 0.0;
    
    float fog_dist_intensity = mdlEnvView.cFogColor.a * (-view_pos.z - mdlEnvView.cFogStart);
    fog_intensity = clamp(clamp(1.0 - exp2(-fog_dist_intensity), 0.0, 1.0) * mdlEnvView.cFogMax, 0.0, 1.0);

    float dot_y = dot(view_pos, mdlEnvView.cViewAxisY);
    float y_fog_dist_intensity = mdlEnvView.cYFogColor.a * (-dot_y - mdlEnvView.cYFogStart);
    y_fog_intensity = clamp(clamp(1.0 - exp2(-y_fog_dist_intensity), 0.0, 1.0) * mdlEnvView.cYFogMax, 0.0, 1.0);

    if (fog_intensity + y_fog_intensity < 0.00001)
        return color;
    
    float sum_fog = fog_intensity + y_fog_intensity + 0.00001;
    float mix_rate = fog_intensity / sum_fog;
    vec3 final_fog_color = mix(mdlEnvView.cYFogColor.rgb, mdlEnvView.cFogColor.rgb, mix_rate);
    float transmittance = clamp((1.0 - fog_intensity) * (1.0 - y_fog_intensity), 0.0, 1.0);
    
    return mix(color, final_fog_color, 1.0 - transmittance);
}
`;
}
