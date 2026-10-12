import { Composition } from 'remotion';
import { AiTeammates, DURATION_SECONDS } from './teammates/AiTeammates';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AiTeammates"
        component={AiTeammates}
        durationInFrames={Math.ceil(DURATION_SECONDS * 30)}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
