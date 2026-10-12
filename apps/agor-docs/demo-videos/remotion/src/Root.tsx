import { Composition } from 'remotion';
import { AiTeammates, DURATION_SECONDS } from './teammates/AiTeammates';
import { AiTeammatesBebop, BEBOP_SECONDS } from './teammates/Bebop';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AiTeammatesBebop"
        component={AiTeammatesBebop}
        durationInFrames={Math.ceil(BEBOP_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="AiTeammatesGrid"
        component={AiTeammates}
        durationInFrames={Math.ceil(DURATION_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
